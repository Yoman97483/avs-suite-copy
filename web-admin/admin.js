// admin.js

// Interception globale des promesses rejetées Supabase (403)
// pour éviter les "Uncaught (in promise)" dans la console,
// tout en gardant un log clair.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (
    reason &&
    typeof reason === 'object' &&
    reason.code === 403
  ) {
    console.warn('Rejet de promesse Supabase intercepté (403 RLS)', reason);
    event.preventDefault();
  }
});

import { supabase, supabaseAuthAdmin } from './supabaseClient.js';


const ADMIN_EMAIL = 'avs.run974@gmail.com';

// --- Mémorise les interventions validées manuellement dans cette session ---
const validatedInterventions = new Set();

// --- Mémorise les semaines repliées (persistant dans le navigateur) ---
const WEEK_COLLAPSE_KEY = 'avs_admin_week_collapsed';
let collapsedWeeks = {};
try {
  const savedCollapsed = localStorage.getItem(WEEK_COLLAPSE_KEY);
  collapsedWeeks = savedCollapsed ? JSON.parse(savedCollapsed) : {};
} catch (e) {
  console.error('Erreur lecture collapsedWeeks', e);
  collapsedWeeks = {};
}

// --- Memorise les mois replies dans les bilans mensuels ---
const MONTH_SUMMARY_COLLAPSE_KEY = 'avs_admin_month_summary_collapsed';
let collapsedSummaryMonths = {};
try {
  const savedCollapsedSummaryMonths = localStorage.getItem(MONTH_SUMMARY_COLLAPSE_KEY);
  collapsedSummaryMonths = savedCollapsedSummaryMonths
    ? JSON.parse(savedCollapsedSummaryMonths)
    : {};
} catch (e) {
  console.error('Erreur lecture collapsedSummaryMonths', e);
  collapsedSummaryMonths = {};
}

// --- Google Maps Platform (geocodage adresse et calcul des distances) ---
const GOOGLE_MAPS_API_PATH = '/api/google-maps';
const SYNC_DISTANCES_API_PATH = '/api/sync-distances';
let missingDistanceSyncPromise = null;
let pointageRealtimeChannel = null;
let pointageRealtimeRefreshTimer = null;

function refreshActivePointageView() {
  if (pointageRealtimeRefreshTimer) {
    clearTimeout(pointageRealtimeRefreshTimer);
  }

  pointageRealtimeRefreshTimer = setTimeout(() => {
    pointageRealtimeRefreshTimer = null;
    const activeTabId = document.querySelector('.tab.active')?.id;

    if (activeTabId === 'interventions-tab') {
      void loadInterventions();
    } else if (activeTabId === 'intervention-bilan-tab') {
      void loadInterventionBilan();
    } else if (activeTabId === 'schedule-tab') {
      void loadEmployeeSchedule();
    } else if (activeTabId === 'pointages-tab') {
      void loadPointages();
    }
  }, 150);
}

function subscribeToPointageInserts() {
  if (pointageRealtimeChannel) return;

  pointageRealtimeChannel = supabase
    .channel('admin-pointages-refresh')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'pointages' },
      refreshActivePointageView
    )
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[Realtime] Ecoute des nouveaux pointages indisponible :', status);
      }
    });
}

function stopPointageRealtimeSubscription() {
  if (pointageRealtimeRefreshTimer) {
    clearTimeout(pointageRealtimeRefreshTimer);
    pointageRealtimeRefreshTimer = null;
  }
  if (!pointageRealtimeChannel) return;

  const channel = pointageRealtimeChannel;
  pointageRealtimeChannel = null;
  void supabase.removeChannel(channel);
}

async function geocodeAddress(address) {
  try {
    if (!address) return { latitude: null, longitude: null };
    const res = await fetch(GOOGLE_MAPS_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'geocode', address }),
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json?.error || 'Erreur Google Geocoding');
    }
    const latitude = json.latitude == null ? null : Number(json.latitude);
    const longitude = json.longitude == null ? null : Number(json.longitude);
    if (
      latitude == null ||
      Number.isNaN(latitude) ||
      longitude == null ||
      Number.isNaN(longitude)
    ) {
      throw new Error('Coordonnées invalides');
    }
    return {
      latitude,
      longitude,
      formattedAddress: json.formattedAddress || null,
    };
  } catch (e) {
    console.warn('[Google Maps] Geocodage impossible :', e?.message || e);
    return {
      latitude: null,
      longitude: null,
      _geocodeError: e?.message || String(e),
    };
  }
}

async function calculateDistanceBetweenPoints(origin, destination) {
  const res = await fetch(GOOGLE_MAPS_API_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'distance', origin, destination }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error || 'Erreur Google Distance Matrix');
  }

  const distanceKm = Number(json.distanceKm);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw new Error('Distance Google invalide');
  }
  return distanceKm;
}

async function getClientCoordinates(clientId) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, address, latitude, longitude')
    .eq('id', clientId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Client introuvable');

  let latitude = data.latitude == null ? null : Number(data.latitude);
  let longitude = data.longitude == null ? null : Number(data.longitude);

  if (
    (latitude == null ||
      Number.isNaN(latitude) ||
      longitude == null ||
      Number.isNaN(longitude)) &&
    data.address
  ) {
    const geo = await geocodeAddress(data.address);
    latitude = geo.latitude;
    longitude = geo.longitude;
    if (geo._geocodeError || latitude == null || longitude == null) {
      throw new Error(
        `Coordonnees GPS manquantes pour ${data.name || 'ce client'}`
      );
    }

    await supabase
      .from('clients')
      .update({
        latitude,
        longitude,
        geocoded_at: new Date().toISOString(),
        geocode_status: 'ok',
      })
      .eq('id', clientId);
  }

  if (
    latitude == null ||
    Number.isNaN(latitude) ||
    longitude == null ||
    Number.isNaN(longitude)
  ) {
    throw new Error(`Coordonnees GPS manquantes pour ${data.name || 'ce client'}`);
  }

  return { latitude, longitude };
}

async function calculateDistanceForClients(clientAId, clientBId) {
  const [origin, destination] = await Promise.all([
    getClientCoordinates(clientAId),
    getClientCoordinates(clientBId),
  ]);
  return calculateDistanceBetweenPoints(origin, destination);
}

async function syncNeededClientDistances(options = {}) {
  const { silent = true } = options;
  if (missingDistanceSyncPromise) return missingDistanceSyncPromise;

  missingDistanceSyncPromise = (async () => {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return null;

    const response = await fetch(SYNC_DISTANCES_API_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ limit: 50 }),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result?.error || 'Synchronisation des distances impossible');
    }

    if (!silent && result.inserted > 0) {
      setMissingDistancesMessage(
        `${result.inserted} distance(s) necessaire(s) calculee(s) automatiquement.`
      );
    }

    return result;
  })().finally(() => {
    missingDistanceSyncPromise = null;
  });

  return missingDistanceSyncPromise;
}

// Sections / login
const passwordResetSection = document.getElementById('password-reset-section');
const passwordResetForm = document.getElementById('password-reset-form');
const newPasswordInput = document.getElementById('new-password-input');
const confirmPasswordInput = document.getElementById('confirm-password-input');
const passwordResetMessage = document.getElementById('password-reset-message');
const topbarTitle = document.getElementById('topbar-title');
const loginSection = document.getElementById('login-section');
const adminSection = document.getElementById('admin-section');
const loginForm = document.getElementById('login-form');
const emailInput = document.getElementById('email-input');
const passwordInput = document.getElementById('password-input');
const usernameHidden = document.getElementById('username-hidden');
const loginError = document.getElementById('login-error');
const adminEmail = document.getElementById('admin-email');
const logoutBtn = document.getElementById('logout-btn');
const welcomeCard = document.getElementById('welcome-card');
// --- Contrôle du pré-remplissage Chrome (email/mot de passe) ---
// Objectif :
// - Ne PAS afficher de suggestions au focus sur l'email.
// - Activer le champ mot de passe uniquement quand l'email admin est saisi.
// - Permettre à Chrome de proposer le mot de passe enregistré AU MOMENT où
//   l'utilisateur passe au champ mot de passe (après saisie de l'email).
(function setupLoginAutofillControl() {
  if (!emailInput || !passwordInput) return;

  // Nettoyage au chargement
  emailInput.value = '';
  passwordInput.value = '';
  passwordInput.disabled = true;
  if (usernameHidden) usernameHidden.value = '';

  const isAdminEmail = (value) =>
    (value || '').trim().toLowerCase() === (ADMIN_EMAIL || '').toLowerCase();

  const onEmailChange = () => {
    const email = emailInput.value.trim();
    if (isAdminEmail(email)) {
      // On remplit le champ caché "username" pour que Chrome puisse associer
      // l'identifiant + mot de passe enregistré.
      if (usernameHidden) usernameHidden.value = email;
      passwordInput.disabled = false;
    } else {
      if (usernameHidden) usernameHidden.value = '';
      passwordInput.value = '';
      passwordInput.disabled = true;
    }
  };

  emailInput.addEventListener('input', onEmailChange);
})();

// Employés – éléments du DOM
const employeesTableBody = document.getElementById('employees-table-body');
const employeeForm = document.getElementById('employee-form');
const employeeIdInput = document.getElementById('employee-id');
const employeeFirstNameInput = document.getElementById('employee-first-name');
const employeeLastNameInput = document.getElementById('employee-last-name');
const employeeAddressInput = document.getElementById('employee-address');
const employeePhoneInput = document.getElementById('employee-phone');
const employeeEmailInput = document.getElementById('employee-email');
const employeeResetBtn = document.getElementById('employee-reset-btn');
const employeeFormMessage = document.getElementById('employee-form-message');

// Clients – éléments du DOM
const clientsTableBody = document.getElementById('clients-table-body');
const clientForm = document.getElementById('client-form');
const clientIdInput = document.getElementById('client-id');
const clientNameInput = document.getElementById('client-name');
const clientAddressInput = document.getElementById('client-address');
const clientPhoneInput = document.getElementById('client-phone');
const clientNotesInput = document.getElementById('client-notes');
const clientResetBtn = document.getElementById('client-reset-btn');
const clientFormMessage = document.getElementById('client-form-message');

// Interventions – éléments du DOM
const interventionsTableBody = document.getElementById('interventions-table-body');
const interventionForm = document.getElementById('intervention-form');
const interventionIdInput = document.getElementById('intervention-id');
const interventionClientSelect = document.getElementById('intervention-client-id');
const interventionEmployeeSelect = document.getElementById('intervention-employee-id');
const interventionDateInput = document.getElementById('intervention-date');
const interventionStartTimeInput = document.getElementById('intervention-start-time');
const interventionEndTimeInput = document.getElementById('intervention-end-time');
const interventionIsWeeklyInput = null; // plus d’hebdomadaire
const interventionResetBtn = document.getElementById('intervention-reset-btn');
const interventionFormMessage = document.getElementById('intervention-form-message');
const interventionBilanMessage = document.getElementById('intervention-bilan-message');
const interventionBilanTableBody = document.getElementById('intervention-bilan-table-body');
const interventionBilanForm = document.getElementById('intervention-bilan-form');
const interventionBilanIdInput = document.getElementById('intervention-bilan-id');
const interventionBilanClientSelect = document.getElementById('intervention-bilan-client-id');
const interventionBilanEmployeeSelect = document.getElementById('intervention-bilan-employee-id');
const interventionBilanDateInput = document.getElementById('intervention-bilan-date');
const interventionBilanStartTimeInput = document.getElementById('intervention-bilan-start-time');
const interventionBilanEndTimeInput = document.getElementById('intervention-bilan-end-time');
const interventionBilanResetBtn = document.getElementById('intervention-bilan-reset-btn');
const interventionBilanFormMessage = document.getElementById('intervention-bilan-form-message');

// Emploi du temps – éléments du DOM
const scheduleEmployeeSelect = document.getElementById('schedule-employee-id');
const scheduleWeekStartInput = document.getElementById('schedule-week-start');
const scheduleCurrentWeekBtn = document.getElementById('schedule-current-week-btn');
const scheduleMessage = document.getElementById('schedule-message');
const scheduleForm = document.getElementById('schedule-form');
const scheduleInterventionIdInput = document.getElementById('schedule-intervention-id');
const scheduleClientSelect = document.getElementById('schedule-client-id');
const scheduleDateInput = document.getElementById('schedule-date');
const scheduleStartTimeInput = document.getElementById('schedule-start-time');
const scheduleEndTimeInput = document.getElementById('schedule-end-time');
const scheduleNewBtn = document.getElementById('schedule-new-btn');
const scheduleFormMessage = document.getElementById('schedule-form-message');
const scheduleWeekTitle = document.getElementById('schedule-week-title');
const scheduleTableBody = document.getElementById('schedule-table-body');

// Pointages – éléments du DOM
const pointagesTableBody = document.getElementById('pointages-table-body');

// Trajets (client_distances) – éléments du DOM
const distancesTableBody = document.getElementById('distances-table-body');
const distanceForm = document.getElementById('distance-form');
const distanceIdInput = document.getElementById('distance-id');
const distanceClientASelect = document.getElementById('distance-client-a-id');
const distanceClientBSelect = document.getElementById('distance-client-b-id');
const distanceKmInput = document.getElementById('distance-km');
const distanceCommentInput = document.getElementById('distance-comment');
const distanceResetBtn = document.getElementById('distance-reset-btn');
const distanceFormMessage = document.getElementById('distance-form-message');

// Trajets manquants – éléments du DOM
const missingDistancesTableBody = document.getElementById('missing-distances-table-body');
const missingDistancesMessage = document.getElementById('missing-distances-message');

// Bilan mensuel – éléments du DOM
const employeeMonthSummaryTableBody = document.getElementById('employee-month-summary-table-body');
const clientMonthlyBilanMessage = document.getElementById('client-monthly-bilan-message');
const clientMonthlyBilanTableBody = document.getElementById('client-monthly-bilan-table-body');
const employeeMonthSummaryMessage = document.getElementById('employee-month-summary-message');

function getAuthHashParams() {
  return new URLSearchParams(window.location.hash.replace(/^#/, ''));
}

function isPasswordRecoveryRedirect() {
  const params = getAuthHashParams();
  return (
    params.get('type') === 'recovery' ||
    params.get('error_code') === 'otp_expired' ||
    params.get('error') === 'access_denied'
  );
}

function showPasswordReset(message = '', isError = false) {
  stopPointageRealtimeSubscription();
  document.title = 'AVS';
  if (topbarTitle) topbarTitle.textContent = 'AVS';
  passwordResetSection?.classList.remove('hidden');
  loginSection.classList.add('hidden');
  adminSection.classList.add('hidden');
  logoutBtn.classList.add('hidden');
  adminEmail.textContent = '';

  if (passwordResetMessage) {
    passwordResetMessage.textContent = message;
    passwordResetMessage.classList.toggle('hidden', !message);
    passwordResetMessage.classList.toggle('error', isError);
    passwordResetMessage.classList.toggle('success', !!message && !isError);
  }
}

function showLogin() {
  stopPointageRealtimeSubscription();
  document.title = 'AVS - Administration';
  if (topbarTitle) topbarTitle.textContent = 'AVS - Administration';
  passwordResetSection?.classList.add('hidden');
  loginSection.classList.remove('hidden');
  adminSection.classList.add('hidden');
  logoutBtn.classList.add('hidden');
  adminEmail.textContent = '';

  // Remise à zéro du formulaire de connexion
  if (emailInput) emailInput.value = '';
  if (passwordInput) {
    passwordInput.value = '';
    passwordInput.disabled = true;
  }
  if (usernameHidden) usernameHidden.value = '';
}

function showAdmin(user) {
  document.title = 'AVS - Administration';
  if (topbarTitle) topbarTitle.textContent = 'AVS - Administration';
  loginSection.classList.add('hidden');
  adminSection.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');
  adminEmail.textContent = user.email;

  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  if (welcomeCard) {
    welcomeCard.classList.remove('hidden');
  }
  if (typeof resetEmployeeForm === 'function') {
    resetEmployeeForm();
  }
  subscribeToPointageInserts();
}

async function restoreSession() {
  if (isPasswordRecoveryRedirect()) {
    const params = getAuthHashParams();
    const errorDescription = params.get('error_description');

    if (params.get('error')) {
      showPasswordReset(
        errorDescription
          ? decodeURIComponent(errorDescription.replace(/\+/g, ' '))
          : 'Le lien de réinitialisation est invalide ou a expiré. Demandez un nouveau lien.',
        true
      );
      return;
    }

    showPasswordReset();
    return;
  }

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    showLogin();
    return;
  }
  if (data.user.email !== ADMIN_EMAIL) {
    await supabase.auth.signOut();
    showLogin();
    return;
  }
  showAdmin(data.user);
}

// ---- Connexion / déconnexion admin ----

if (passwordResetForm) {
  passwordResetForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const newPassword = newPasswordInput?.value.trim() ?? '';
    const confirmPassword = confirmPasswordInput?.value.trim() ?? '';

    if (passwordResetMessage) {
      passwordResetMessage.classList.add('hidden');
      passwordResetMessage.textContent = '';
      passwordResetMessage.classList.remove('error', 'success');
    }

    if (!newPassword || !confirmPassword) {
      showPasswordReset('Merci de saisir et confirmer le nouveau mot de passe.', true);
      return;
    }

    if (newPassword.length < 6) {
      showPasswordReset('Le mot de passe doit contenir au moins 6 caractères.', true);
      return;
    }

    if (newPassword !== confirmPassword) {
      showPasswordReset('Les deux mots de passe ne correspondent pas.', true);
      return;
    }

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      showPasswordReset(error.message ?? 'Impossible de changer le mot de passe.', true);
      return;
    }

    window.history.replaceState({}, document.title, window.location.pathname);
    await supabase.auth.signOut();
    showLogin();
    loginError.textContent = 'Mot de passe modifié. Vous pouvez maintenant vous connecter.';
    loginError.classList.remove('hidden', 'error');
    loginError.classList.add('success');
  });
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.classList.add('hidden');
  loginError.classList.add('error');
  loginError.classList.remove('success');
  loginError.textContent = '';

  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    loginError.textContent = 'Merci de saisir un email et un mot de passe.';
    loginError.classList.remove('hidden');
    return;
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
      loginError.textContent = error?.message ?? 'Connexion impossible.';
      loginError.classList.remove('hidden');
      return;
    }

    if (data.user.email !== ADMIN_EMAIL) {
      await supabase.auth.signOut();
      loginError.textContent =
        "Cette interface est réservée à l'administrateur AVS.";
      loginError.classList.remove('hidden');
      return;
    }

    showAdmin(data.user);
  } catch (err) {
    loginError.textContent = err?.message ?? 'Erreur inconnue.';
    loginError.classList.remove('hidden');
  }
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  if (emailInput) emailInput.value = '';
  if (passwordInput) {
    passwordInput.value = '';
    passwordInput.disabled = true;
  }
  if (usernameHidden) usernameHidden.value = '';
  showLogin();
});

// --------- Gestion des onglets ---------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tabId = btn.getAttribute('data-tab');

    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
    if (welcomeCard) {
      welcomeCard.classList.add('hidden');
    }

    btn.classList.add('active');
    const section = document.getElementById(tabId);
    if (section) section.classList.add('active');

    // On coupe les auto-refresh
    stopAutoRefreshInterventions();
    stopAutoRefreshSchedule();
    stopAutoRefreshInterventionBilan();
    stopAutoRefreshPointages();

    // Puis on charge l’onglet sélectionné
    if (tabId === 'employees-tab') {
      resetEmployeeForm();
      loadEmployees();
    } else if (tabId === 'clients-tab') {
      loadClients();
    } else if (tabId === 'interventions-tab') {
      loadInterventionsLookups();
      loadInterventions();
      startAutoRefreshInterventions();
    } else if (tabId === 'intervention-bilan-tab') {
      loadInterventionBilanLookups();
      loadInterventionBilan();
      startAutoRefreshInterventionBilan();
    } else if (tabId === 'schedule-tab') {
      loadScheduleLookups().then(() => {
        setScheduleCurrentWeekIfEmpty();
        loadEmployeeSchedule();
      });
      startAutoRefreshSchedule();
    } else if (tabId === 'pointages-tab') {
      loadPointages();
      startAutoRefreshPointages();
    } else if (tabId === 'distances-tab') {
      loadClientsForDistances();
      loadDistances();
    } else if (tabId === 'missing-distances-tab') {
      loadMissingDistances();
    } else if (tabId === 'employee-month-summary-tab') {
      loadEmployeeMonthSummary();
    } else if (tabId === 'client-monthly-bilan-tab') {
      loadClientMonthlyBilan();
    }
  });
});

// --------- Gestion Employés ---------

function setEmployeeFormMessage(text, type = 'info') {
  if (!employeeFormMessage) return;
  employeeFormMessage.textContent = text || '';
  employeeFormMessage.classList.remove('error');
  if (!text) return;
  if (type === 'error') {
    employeeFormMessage.classList.add('error');
  }
}

function resetEmployeeForm(clearMessage = true) {
  employeeIdInput.value = '';
  employeeFirstNameInput.value = '';
  employeeLastNameInput.value = '';
  employeeAddressInput.value = '';
  employeePhoneInput.value = '';
  employeeEmailInput.value = '';
  if (clearMessage) setEmployeeFormMessage('');
}

function generateTemporaryPassword() {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = new Uint8Array(28);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}

async function loadEmployees() {
  if (!employeesTableBody) return;

  employeesTableBody.innerHTML =
    '<tr><td colspan="7">Chargement…</td></tr>';

  const { data, error } = await supabase
    .from('employees')
    .select('id, first_name, last_name, address, phone, email, created_at')
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true });

  if (error) {
    employeesTableBody.innerHTML =
      '<tr><td colspan="7">Erreur : ' +
      (error.message ?? 'chargement impossible') +
      '</td></tr>';
    return;
  }

  const employees = data ?? [];
  if (employees.length === 0) {
    employeesTableBody.innerHTML =
      '<tr><td colspan="7">Aucun employé.</td></tr>';
    return;
  }

  employeesTableBody.innerHTML = '';
  employees.forEach((emp) => {
    const tr = document.createElement('tr');
    const created = emp.created_at
      ? new Date(emp.created_at).toLocaleString('fr-FR')
      : '';

    tr.dataset.id = emp.id;
    tr.innerHTML = `
      <td>${emp.first_name ?? ''}</td>
      <td>${emp.last_name ?? ''}</td>
      <td>${emp.address ?? ''}</td>
      <td>${emp.phone ?? ''}</td>
      <td>${emp.email ?? ''}</td>
      <td>${created}</td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-secondary btn-small" data-action="edit">Modifier</button>
          <button class="btn btn-secondary btn-small" data-action="password-reset">Envoyer reset mot de passe</button>
          <button class="btn btn-secondary btn-small" data-action="delete">Supprimer</button>
        </div>
      </td>
    `;
    employeesTableBody.appendChild(tr);
  });
}

if (employeeForm) {
  employeeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setEmployeeFormMessage('');

    const id = employeeIdInput.value || null;
    const first_name = employeeFirstNameInput.value.trim();
    const last_name = employeeLastNameInput.value.trim();
    const address = employeeAddressInput.value.trim() || null;
    const phone = employeePhoneInput.value.trim() || null;
    const email = employeeEmailInput.value.trim() || null;

    if (!first_name || !last_name) {
      setEmployeeFormMessage('Prénom et nom sont obligatoires.', 'error');
      return;
    }

    if (!id && !email) {
      setEmployeeFormMessage(
        "Pour créer un employé, l'email est obligatoire.",
        'error'
      );
      return;
    }

    try {
      if (id) {
        const { error } = await supabase
          .from('employees')
          .update({ first_name, last_name, address, phone, email })
          .eq('id', id);
        if (error) throw error;
        setEmployeeFormMessage('Employé mis à jour.');
      } else {
        const { data: signUpData, error: signUpError } =
          await supabaseAuthAdmin.auth.signUp({
            email,
            password: generateTemporaryPassword(),
          });

        if (signUpError || !signUpData.user) {
          throw signUpError || new Error("Création de l'utilisateur impossible.");
        }

        const userId = signUpData.user.id;

        const { error: insertError } = await supabase.from('employees').insert([
          {
            id: userId,
            first_name,
            last_name,
            address,
            phone,
            email,
          },
        ]);

        if (insertError) {
          throw insertError;
        }

        const { error: resetError } =
          await supabaseAuthAdmin.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}${window.location.pathname}`,
          });

        if (resetError) {
          setEmployeeFormMessage(
            `Employé créé, mais l'email de définition du mot de passe n'a pas pu être envoyé : ${resetError.message}`,
            'error'
          );
        } else {
          setEmployeeFormMessage(
            `Employé créé. Un email pour définir son mot de passe a été envoyé à ${email}.`
          );
        }
      }

      await loadEmployees();
      resetEmployeeForm(false);
    } catch (err) {
      setEmployeeFormMessage(
        err?.message ?? "Erreur lors de l'enregistrement de l'employé.",
        'error'
      );
    }
  });
}

if (employeeResetBtn) {
  employeeResetBtn.addEventListener('click', () => {
    resetEmployeeForm();
  });
}

if (employeesTableBody) {
  employeesTableBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.dataset.action;
    if (!action) return;

    const row = target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;

    if (action === 'password-reset') {
      const cells = row.querySelectorAll('td');
      const email = (cells[4]?.textContent || '').trim();

      if (!email) {
        alert("Cet employé n'a pas d'adresse email enregistrée.");
        return;
      }

      target.setAttribute('disabled', 'disabled');
      const originalLabel = target.textContent;
      target.textContent = 'Envoi en cours...';

      const { error } = await supabaseAuthAdmin.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}${window.location.pathname}`,
      });

      target.removeAttribute('disabled');
      target.textContent = originalLabel;

      if (error) {
        alert(
          `Impossible d'envoyer le lien de réinitialisation à ${email} : ${error.message}`
        );
        return;
      }

      alert(`Email de réinitialisation envoyé à ${email}.`);
    } else if (action === 'edit') {
      const cells = row.querySelectorAll('td');
      employeeIdInput.value = id;
      employeeFirstNameInput.value = (cells[0].textContent || '').trim();
      employeeLastNameInput.value = (cells[1].textContent || '').trim();
      employeeAddressInput.value = (cells[2].textContent || '').trim();
      employeePhoneInput.value = (cells[3].textContent || '').trim();
      employeeEmailInput.value = (cells[4].textContent || '').trim();
      setEmployeeFormMessage(
        "Modification d'un employé existant. Utilisez le bouton Envoyer reset mot de passe dans la liste pour lui transmettre un lien."
      );
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (action === 'delete') {
      const { count, error: countError } = await supabase
        .from('interventions')
        .select('id', { count: 'exact', head: true })
        .eq('employee_id', id);

      if (countError) {
        alert(countError.message ?? 'Impossible de vérifier les interventions.');
        return;
      }

      if ((count ?? 0) > 0) {
        alert(
          "Impossible de supprimer cet employé : il est lié à des interventions déjà créées."
        );
        return;
      }

      const { error } = await supabase
        .from('employees')
        .delete()
        .eq('id', id);
      if (error) {
        alert(error.message ?? 'Suppression impossible.');
        return;
      }

      if (employeeIdInput.value === id) {
        resetEmployeeForm();
      }
      await loadEmployees();
    }
  });
}

// --------- Gestion Clients ---------

function setClientFormMessage(text, type = 'info') {
  if (!clientFormMessage) return;
  clientFormMessage.textContent = text || '';
  clientFormMessage.classList.remove('error');
  if (!text) return;
  if (type === 'error') {
    clientFormMessage.classList.add('error');
  }
}

function resetClientForm() {
  clientIdInput.value = '';
  clientNameInput.value = '';
  clientAddressInput.value = '';
  clientPhoneInput.value = '';
  clientNotesInput.value = '';
  setClientFormMessage('');
}

async function loadClients() {
  if (!clientsTableBody) return;

  clientsTableBody.innerHTML =
    '<tr><td colspan="6">Chargement…</td></tr>';

  const { data, error } = await supabase
    .from('clients')
    .select('id, name, address, phone, notes, created_at')
    .order('name', { ascending: true });

  if (error) {
    clientsTableBody.innerHTML =
      '<tr><td colspan="6">Erreur : ' +
      (error.message ?? 'chargement impossible') +
      '</td></tr>';
    return;
  }

  const clients = data ?? [];
  if (clients.length === 0) {
    clientsTableBody.innerHTML =
      '<tr><td colspan="6">Aucun client.</td></tr>';
    return;
  }

  clientsTableBody.innerHTML = '';
  clients.forEach((client) => {
    const tr = document.createElement('tr');
    const created = client.created_at
      ? new Date(client.created_at).toLocaleString('fr-FR')
      : '';

    tr.dataset.id = client.id;
    tr.innerHTML = `
      <td>${client.name ?? ''}</td>
      <td>${client.address ?? ''}</td>
      <td>${client.phone ?? ''}</td>
      <td>${client.notes ?? ''}</td>
      <td>${created}</td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-secondary btn-small" data-action="edit">Modifier</button>
          <button class="btn btn-secondary btn-small" data-action="delete">Supprimer</button>
        </div>
      </td>
    `;
    clientsTableBody.appendChild(tr);
  });
}

if (clientForm) {
  clientForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setClientFormMessage('');

    const id = clientIdInput.value || null;
    const name = clientNameInput.value.trim();
    const address = clientAddressInput.value.trim() || null;
    const phone = clientPhoneInput.value.trim() || null;
    const notes = clientNotesInput.value.trim() || null;

    if (!name) {
      setClientFormMessage('Le nom du client est obligatoire.', 'error');
      return;
    }

    try {
      let latitude = null;
      let longitude = null;
      let geocode_status = address ? 'pending' : null;
      if (address) {
        setClientFormMessage('Géocodage de l’adresse…');
        const geo = await geocodeAddress(address);
        latitude = geo.latitude;
        longitude = geo.longitude;
        if (geo._geocodeError) {
          geocode_status = 'error';
          setClientFormMessage(
            'Client enregistré sans coordonnées GPS : ' + geo._geocodeError
          );
        } else {
          geocode_status = 'ok';
        }
      }

      if (id) {
        const payload = {
          name,
          address,
          phone,
          notes,
          latitude,
          longitude,
          geocode_status,
        };
        if (geocode_status === 'ok') payload.geocoded_at = new Date().toISOString();
        if (latitude == null) delete payload.latitude;
        if (longitude == null) delete payload.longitude;

        const { error } = await supabase
          .from('clients')
          .update(payload)
          .eq('id', id);
        if (error) throw error;
        setClientFormMessage('Client mis à jour.');
      } else {
        const payload = {
          name,
          address,
          phone,
          notes,
          latitude,
          longitude,
          geocode_status,
          geocoded_at: geocode_status === 'ok' ? new Date().toISOString() : null,
        };
        const { error } = await supabase
          .from('clients')
          .insert([payload]);
        if (error) throw error;
        setClientFormMessage('Client ajouté.');
      }

      await loadClients();
      syncNeededClientDistances().catch((err) => {
        console.warn('Synchronisation automatique des distances impossible', err);
      });
      resetClientForm();
    } catch (err) {
      setClientFormMessage(
        err?.message ?? "Erreur lors de l'enregistrement du client.",
        'error'
      );
    }
  });
}

if (clientResetBtn) {
  clientResetBtn.addEventListener('click', () => {
    resetClientForm();
  });
}

if (clientsTableBody) {
  clientsTableBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.dataset.action;
    if (!action) return;

    const row = target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;

    if (action === 'edit') {
      const cells = row.querySelectorAll('td');
      clientIdInput.value = id;
      clientNameInput.value = (cells[0].textContent || '').trim();
      clientAddressInput.value = (cells[1].textContent || '').trim();
      clientPhoneInput.value = (cells[2].textContent || '').trim();
      clientNotesInput.value = (cells[3].textContent || '').trim();
      setClientFormMessage('Modification du client.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (action === 'delete') {
      const { error } = await supabase
        .from('clients')
        .delete()
        .eq('id', id);
      if (error) {
        alert(error.message ?? 'Suppression impossible.');
        return;
      }

      if (clientIdInput.value === id) {
        resetClientForm();
      }
      await loadClients();
    }
  });
}

// --------- Gestion Interventions ---------

function setInterventionFormMessage(text, type = 'info') {
  if (!interventionFormMessage) return;
  interventionFormMessage.textContent = text || '';
  interventionFormMessage.classList.remove('error');
  if (!text) return;
  if (type === 'error') {
    interventionFormMessage.classList.add('error');
  }
}

function resetInterventionForm() {
  interventionIdInput.value = '';
  interventionClientSelect.value = '';
  interventionEmployeeSelect.value = '';
  interventionDateInput.value = '';
  interventionStartTimeInput.value = '';
  interventionEndTimeInput.value = '';
  if (interventionIsWeeklyInput) interventionIsWeeklyInput.checked = false;
  setInterventionFormMessage('');
}

function setInterventionBilanFormMessage(message, type = 'info') {
  if (!interventionBilanFormMessage) return;
  interventionBilanFormMessage.textContent = message || '';
  interventionBilanFormMessage.classList.remove('error');
  if (type === 'error') interventionBilanFormMessage.classList.add('error');
}

function resetInterventionBilanForm() {
  if (!interventionBilanForm) return;
  interventionBilanIdInput.value = '';
  interventionBilanClientSelect.value = '';
  interventionBilanEmployeeSelect.value = '';
  interventionBilanDateInput.value = '';
  interventionBilanStartTimeInput.value = '';
  interventionBilanEndTimeInput.value = '';
  setInterventionBilanFormMessage('');
}

function normalizeInterventionState(value) {
  return String(value || 'en attente').trim().toLowerCase();
}

function canAdminValidateOrDelete(value) {
  const state = normalizeInterventionState(value);
  return state !== 'fait' && state !== 'validé' && state !== 'valide';
}

function canEditPlannedIntervention(value) {
  return normalizeInterventionState(value) === 'en attente';
}

function getInterventionDisplayStatus(businessStatus, actualStart, actualEnd) {
  const state = normalizeInterventionState(businessStatus);
  if (state === 'fait' || state === 'validé' || state === 'valide') {
    return businessStatus;
  }
  if (actualStart && !actualEnd) return 'en cours';
  return businessStatus || 'en attente';
}

async function loadInterventionsLookups() {
  if (!interventionClientSelect || !interventionEmployeeSelect) return;

  const { data: clients, error: clientsError } = await supabase
    .from('clients')
    .select('id, name')
    .order('name', { ascending: true });

  if (!clientsError) {
    interventionClientSelect.innerHTML =
      '<option value="">-- Choisir un client --</option>';
    (clients || []).forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || '';
      interventionClientSelect.appendChild(opt);
    });
  }

  const { data: employees, error: employeesError } = await supabase
    .from('employees')
    .select('id, first_name, last_name')
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true });

  if (!employeesError) {
    interventionEmployeeSelect.innerHTML =
      '<option value="">-- Choisir un employé --</option>';
    (employees || []).forEach((e) => {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim();
      interventionEmployeeSelect.appendChild(opt);
    });
  }
}

async function loadInterventions() {
  if (!interventionsTableBody) return;

  // On ne vide plus le tableau tant qu’on n’a pas de nouvelles données,
  // pour éviter tout clignotement.
  const hadRowsBefore = interventionsTableBody.querySelector('tr');

  const { data, error } = await supabase
    .from('interventions_progress_admin')
    .select(`
      id,
      date,
      status,
      client_name,
      employee_name,
      start_time_planned,
      end_time_planned,
      actual_start,
      actual_end,
      fait,
      client_id,
      employee_id,
      duplicated_from_intervention_id
    `)
    .order('date', { ascending: true })
    .order('start_time_planned', { ascending: true });

  if (error) {
    if (!hadRowsBefore) {
      interventionsTableBody.innerHTML =
        '<tr><td colspan="7">Erreur : ' +
        (error.message ?? 'chargement impossible') +
        '</td></tr>';
    }
    return;
  }

  const interventions = data ?? [];

  if (interventions.length === 0) {
    if (!hadRowsBefore) {
      interventionsTableBody.innerHTML =
        '<tr><td colspan="7">Aucune intervention.</td></tr>';
    }
    return;
  }

  // On a des données : on rafraîchit proprement le tableau,
  // en les groupant par semaine dans des bandeaux déroulants.
  interventionsTableBody.innerHTML = '';

  let currentWeekKey = null;

  // petite fonction pour calculer la semaine (lundi → dimanche)
  function getWeekInfo(dateStr) {
    if (!dateStr) {
      return {
        weekKey: 'no-date',
        label: 'Sans date',
      };
    }
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) {
      return {
        weekKey: 'no-date',
        label: 'Sans date',
      };
    }
    const day = d.getDay(); // 0 = dimanche, 1 = lundi, ...
    const offsetToMonday = (day + 6) % 7; // transforme lundi en 0
    const monday = new Date(d);
    monday.setDate(d.getDate() - offsetToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const key =
      monday.getFullYear() +
      '-' +
      String(monday.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(monday.getDate()).padStart(2, '0');

    const label =
      'Semaine du ' +
      monday.toLocaleDateString('fr-FR') +
      ' au ' +
      sunday.toLocaleDateString('fr-FR');

    return {
      weekKey: key,
      label,
    };
  }

  interventions.forEach((intv) => {
    const dateStr = intv.date ?? null;
    const weekInfo = getWeekInfo(dateStr);

    // Si on change de semaine, on insère un bandeau déroulant
    if (weekInfo.weekKey !== currentWeekKey) {
      currentWeekKey = weekInfo.weekKey;

      const isCollapsed = collapsedWeeks[currentWeekKey] === true;

      const headerTr = document.createElement('tr');
      headerTr.classList.add('week-header');
      headerTr.dataset.weekKey = currentWeekKey;
      headerTr.dataset.collapsed = isCollapsed ? 'true' : 'false';
      headerTr.innerHTML = `
        <td colspan="7"
            style="
              background-color: rgba(11,114,133,0.1);
              font-weight: 600;
              cursor: pointer;
              padding: 6px 8px;
            ">
          ${weekInfo.label}
        </td>
      `;
      interventionsTableBody.appendChild(headerTr);
    }

    const tr = document.createElement('tr');
    tr.dataset.week = currentWeekKey;

    const dateLabel = intv.date
      ? new Date(intv.date).toLocaleDateString('fr-FR')
      : '';

    const startStr = intv.start_time_planned ?? '';
    const endStr = intv.end_time_planned ?? '';
    const clientName = intv.client_name ?? '';
    const employeeName = intv.employee_name ?? '';

    const faitRaw = intv.fait ?? 'en attente';
    const isManuallyValidated = validatedInterventions.has(intv.id);
    const fait = isManuallyValidated ? 'validé' : faitRaw;
    const displayStatus = isManuallyValidated
      ? 'validé'
      : getInterventionDisplayStatus(fait, intv.actual_start, intv.actual_end);
    const isDuplicated = Boolean(intv.duplicated_from_intervention_id);

    const canEdit = !isManuallyValidated && canEditPlannedIntervention(fait);
    const canFinalize = !isManuallyValidated && canAdminValidateOrDelete(fait);
    const editDisabledAttr = canEdit ? '' : 'disabled';
    const editDisabledClass = canEdit ? '' : ' disabled';
    const editDisabledStyle = canEdit
      ? ''
      : 'style="background-color:#cccccc; color:#666666; cursor:not-allowed;"';
    const finalizeDisabledAttr = canFinalize ? '' : 'disabled';
    const finalizeDisabledClass = canFinalize ? '' : ' disabled';
    const finalizeDisabledStyle = canFinalize
      ? ''
      : 'style="background-color:#cccccc; color:#666666; cursor:not-allowed;"';

    tr.dataset.id = intv.id;
    tr.dataset.fait = fait;
    tr.dataset.employeeId = intv.employee_id || '';
    tr.dataset.date = intv.date || '';
    tr.dataset.duplicatedFrom = intv.duplicated_from_intervention_id || '';

    if (isDuplicated) {
      tr.classList.add('schedule-duplicated-row');
      tr.classList.add('intervention-duplicated-row');
    }

    // Applique l’état replié/affiché selon collapsedWeeks
    if (collapsedWeeks[currentWeekKey] === true) {
      tr.style.display = 'none';
    }

    tr.innerHTML = `
      <td>${clientName}</td>
      <td>${employeeName}</td>
      <td>${dateLabel}</td>
      <td>${startStr}</td>
      <td>${endStr}</td>
      <td>
        ${displayStatus}
        ${isDuplicated ? '<span class="schedule-duplicate-label">dupliquée</span>' : ''}
      </td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-secondary btn-small${editDisabledClass}"
                  data-action="edit"
                  ${editDisabledAttr}
                  ${editDisabledStyle}>Modifier</button>
          <button class="btn btn-secondary btn-small${finalizeDisabledClass}"
                  data-action="delete"
                  ${finalizeDisabledAttr}
                  ${finalizeDisabledStyle}>Supprimer</button>
          <button class="btn btn-primary btn-small${finalizeDisabledClass}"
                  ${finalizeDisabledAttr}
                  ${finalizeDisabledStyle}
                  data-action="validate">Valider</button>
        </div>
      </td>
    `;
    interventionsTableBody.appendChild(tr);
  });
}

if (interventionForm) {
  interventionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setInterventionFormMessage('');

    const id = interventionIdInput.value || null;
    const client_id = interventionClientSelect.value || null;
    const employee_id = interventionEmployeeSelect.value || null;
    const date = interventionDateInput.value || null;
    const start_time_planned = interventionStartTimeInput.value || null;
    const end_time_planned = interventionEndTimeInput.value || null;

    if (!client_id || !employee_id || !date) {
      setInterventionFormMessage(
        'Client, employé et date sont obligatoires.',
        'error'
      );
      return;
    }

    try {
      if (id) {
        const { error } = await supabase
          .from('interventions')
          .update({ client_id, employee_id, date, start_time_planned, end_time_planned })
          .eq('id', id);
        if (error) throw error;
        setInterventionFormMessage('Intervention mise à jour.');
      } else {
        const { error } = await supabase.from('interventions').insert([
          { client_id, employee_id, date, start_time_planned, end_time_planned, status: 'planned' },
        ]);
        if (error) throw error;
        setInterventionFormMessage('Intervention ajoutée.');
      }

      await loadInterventions();
      syncNeededClientDistances().catch((err) => {
        console.warn('Synchronisation automatique des distances impossible', err);
      });
      resetInterventionForm();
    } catch (err) {
      setInterventionFormMessage(
        err?.message ?? "Erreur lors de l'enregistrement de l'intervention.",
        'error'
      );
    }
  });
}

if (interventionResetBtn) {
  interventionResetBtn.addEventListener('click', () => {
    resetInterventionForm();
  });
}

// Gestion des clics sur les boutons (edit / delete / validate)
if (interventionsTableBody) {
  interventionsTableBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.dataset.action;
    if (!action) return;

    const row = target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;

    const fait = row.dataset.fait || 'en attente';

    if (action === 'edit') {
      if (!canEditPlannedIntervention(fait)) {
        setInterventionFormMessage(
          "Cette intervention a déjà un historique : seul Valider ou Supprimer reste possible si elle n'est pas faite.",
          'error'
        );
        return;
      }
    }

    if (action === 'delete' || action === 'validate') {
      if (!canAdminValidateOrDelete(fait)) {
        setInterventionFormMessage(
          "Cette intervention est déjà faite ou validée.",
          'error'
        );
        return;
      }
    }

    if (action === 'edit') {
      await loadInterventionsLookups();

      const { data, error } = await supabase
        .from('interventions')
        .select('id, client_id, employee_id, date, start_time_planned, end_time_planned')
        .eq('id', id)
        .maybeSingle();

      if (!error && data) {
        interventionIdInput.value = data.id;
        interventionClientSelect.value = data.client_id || '';
        interventionEmployeeSelect.value = data.employee_id || '';
        interventionDateInput.value = data.date || '';
        interventionStartTimeInput.value = data.start_time_planned || '';
        interventionEndTimeInput.value = data.end_time_planned || '';
        setInterventionFormMessage('Modification de l’intervention.');
      } else {
        setInterventionFormMessage(
          "Impossible de charger l'intervention pour modification.",
          'error'
        );
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (action === 'delete') {
      const duplicatedFrom = row.dataset.duplicatedFrom || '';
      const targetDate = row.dataset.date || '';
      const employeeId = row.dataset.employeeId || '';

      if (duplicatedFrom && targetDate && employeeId) {
        const { error: skipError } = await supabase
          .from('intervention_duplication_skips')
          .upsert(
            [
              {
                source_intervention_id: duplicatedFrom,
                employee_id: employeeId,
                target_date: targetDate,
              },
            ],
            { onConflict: 'source_intervention_id,employee_id,target_date' }
          );

        if (skipError) {
          setInterventionFormMessage(
            skipError.message ?? "Impossible d'enregistrer la suppression de la duplication.",
            'error'
          );
          return;
        }
      }

      const { error } = await supabase
        .from('interventions')
        .delete()
        .eq('id', id);

      if (error) {
        alert(error.message ?? 'Suppression impossible.');
        return;
      }

      if (interventionIdInput.value === id) {
        resetInterventionForm();
      }
      await loadInterventions();
    } else if (action === 'validate') {
      try {
        const nowIso = new Date().toISOString();

        const { error } = await supabase
          .from('interventions')
          .update({
            status: 'done',
            saved: true,
            completed_at: nowIso,
          })
          .eq('id', id);

        if (error) {
          alert(
            error.message ??
              "Impossible de valider l'intervention pour le moment."
          );
          return;
        }

        validatedInterventions.add(id);
        syncNeededClientDistances().catch((err) => {
          console.warn('Synchronisation automatique des distances impossible', err);
        });

        const faitCell = row.querySelector('td:nth-child(6)');
        if (faitCell) {
          faitCell.textContent = 'validé';
        }
        row.dataset.fait = 'validé';

        row
          .querySelectorAll('button[data-action="edit"], button[data-action="delete"], button[data-action="validate"]')
          .forEach((btn) => {
            btn.disabled = true;
            btn.classList.add('disabled');
            btn.style.backgroundColor = '#cccccc';
            btn.style.color = '#666666';
            btn.style.cursor = 'not-allowed';
          });

        setInterventionFormMessage("Intervention validée manuellement.");
      } catch (err) {
        alert(
          err?.message ??
            "Erreur inconnue lors de la validation de l'intervention."
        );
      }
    }
  });

  // Gestion du bandeau déroulant par semaine + persistance dans localStorage
  interventionsTableBody.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const tr = target.closest('tr');
    if (!tr) return;
    if (!tr.classList.contains('week-header')) return;

    const weekKey = tr.dataset.weekKey;
    if (!weekKey) return;

    const collapsed = tr.dataset.collapsed === 'true';
    const newCollapsed = !collapsed;
    tr.dataset.collapsed = newCollapsed ? 'true' : 'false';

    // Met à jour l’affichage des lignes de la semaine
    const rows = interventionsTableBody.querySelectorAll(`tr[data-week="${weekKey}"]`);
    rows.forEach((row) => {
      row.style.display = newCollapsed ? 'none' : '';
    });

    // Sauvegarde dans collapsedWeeks + localStorage
    collapsedWeeks[weekKey] = newCollapsed;
    try {
      localStorage.setItem(WEEK_COLLAPSE_KEY, JSON.stringify(collapsedWeeks));
    } catch (e) {
      console.error('Erreur sauvegarde collapsedWeeks', e);
    }
  });
}

// --------- Gestion Emploi du temps ---------

function setScheduleMessage(text, type = 'info') {
  if (!scheduleMessage) return;
  scheduleMessage.textContent = text || '';
  scheduleMessage.classList.remove('error');
  if (text && type === 'error') {
    scheduleMessage.classList.add('error');
  }
}

function setScheduleFormMessage(text, type = 'info') {
  if (!scheduleFormMessage) return;
  scheduleFormMessage.textContent = text || '';
  scheduleFormMessage.classList.remove('error');
  if (text && type === 'error') {
    scheduleFormMessage.classList.add('error');
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function dateToInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseInputDate(value) {
  if (!value) return null;
  const date = new Date(value + 'T00:00:00');
  return Number.isNaN(date.getTime()) ? null : date;
}

function getMonday(date) {
  const monday = new Date(date);
  const day = monday.getDay();
  const offsetToMonday = (day + 6) % 7;
  monday.setDate(monday.getDate() - offsetToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addDaysToDateValue(value, days) {
  const date = parseInputDate(value);
  if (!date) return '';
  return dateToInputValue(addDays(date, days));
}

function interventionSlotKey(row) {
  return [
    row.client_id || '',
    row.employee_id || '',
    row.date || '',
    row.start_time_planned || '',
    row.end_time_planned || '',
  ].join('|');
}

function setScheduleCurrentWeekIfEmpty(force = false) {
  if (!scheduleWeekStartInput) return;
  if (!force && scheduleWeekStartInput.value) return;
  scheduleWeekStartInput.value = dateToInputValue(getMonday(new Date()));
}

function normalizeScheduleWeekStart() {
  if (!scheduleWeekStartInput) return null;
  const selected = parseInputDate(scheduleWeekStartInput.value);
  if (!selected) return null;
  const monday = getMonday(selected);
  scheduleWeekStartInput.value = dateToInputValue(monday);
  return monday;
}

function resetScheduleForm() {
  if (scheduleInterventionIdInput) scheduleInterventionIdInput.value = '';
  if (scheduleClientSelect) scheduleClientSelect.value = '';
  if (scheduleDateInput) scheduleDateInput.value = scheduleWeekStartInput?.value || '';
  if (scheduleStartTimeInput) scheduleStartTimeInput.value = '';
  if (scheduleEndTimeInput) scheduleEndTimeInput.value = '';
  setScheduleFormMessage('');
}

async function loadScheduleLookups() {
  if (!scheduleEmployeeSelect || !scheduleClientSelect) return;

  const previousEmployee = scheduleEmployeeSelect.value;
  const previousClient = scheduleClientSelect.value;

  const { data: employees, error: employeesError } = await supabase
    .from('employees')
    .select('id, first_name, last_name')
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true });

  if (employeesError) {
    setScheduleMessage(
      employeesError.message ?? 'Impossible de charger les employés.',
      'error'
    );
    return;
  }

  scheduleEmployeeSelect.innerHTML =
    '<option value="">-- Choisir un employé --</option>';
  (employees || []).forEach((employee) => {
    const opt = document.createElement('option');
    opt.value = employee.id;
    opt.textContent = `${employee.first_name ?? ''} ${employee.last_name ?? ''}`.trim();
    scheduleEmployeeSelect.appendChild(opt);
  });

  if (previousEmployee) {
    scheduleEmployeeSelect.value = previousEmployee;
  }
  if (!scheduleEmployeeSelect.value && scheduleEmployeeSelect.options.length > 1) {
    scheduleEmployeeSelect.selectedIndex = 1;
  }

  const { data: clients, error: clientsError } = await supabase
    .from('clients')
    .select('id, name')
    .order('name', { ascending: true });

  if (clientsError) {
    setScheduleMessage(
      clientsError.message ?? 'Impossible de charger les clients.',
      'error'
    );
    return;
  }

  scheduleClientSelect.innerHTML =
    '<option value="">-- Choisir un client --</option>';
  (clients || []).forEach((clientRow) => {
    const opt = document.createElement('option');
    opt.value = clientRow.id;
    opt.textContent = clientRow.name || '';
    scheduleClientSelect.appendChild(opt);
  });

  if (previousClient) {
    scheduleClientSelect.value = previousClient;
  }
}

async function duplicateCurrentWeekToNextWeek(employeeId = null, options = {}) {
  const { showMessage = true } = options;
  const currentMonday = getMonday(new Date());
  const nextMonday = addDays(currentMonday, 7);
  const followingMonday = addDays(currentMonday, 14);
  const sourceFrom = dateToInputValue(currentMonday);
  const sourceTo = dateToInputValue(nextMonday);
  const targetFrom = dateToInputValue(nextMonday);
  const targetTo = dateToInputValue(followingMonday);

  let sourceQuery = supabase
    .from('interventions_progress_admin')
    .select(`
      id,
      client_id,
      employee_id,
      date,
      start_time_planned,
      end_time_planned
    `)
    .gte('date', sourceFrom)
    .lt('date', sourceTo)
    .order('date', { ascending: true })
    .order('start_time_planned', { ascending: true });

  if (employeeId) {
    sourceQuery = sourceQuery.eq('employee_id', employeeId);
  }

  const { data: sourceRows, error: sourceError } = await sourceQuery;

  if (sourceError) {
    console.warn('Duplication planning impossible :', sourceError.message);
    return;
  }

  if (!sourceRows || sourceRows.length === 0) return;

  let targetQuery = supabase
    .from('interventions')
    .select('id, duplicated_from_intervention_id, client_id, employee_id, date, start_time_planned, end_time_planned')
    .gte('date', targetFrom)
    .lt('date', targetTo);

  if (employeeId) {
    targetQuery = targetQuery.eq('employee_id', employeeId);
  }

  const { data: targetRows, error: targetError } = await targetQuery;

  if (targetError) {
    console.warn('Lecture semaine suivante impossible :', targetError.message);
    return;
  }

  let skipQuery = supabase
    .from('intervention_duplication_skips')
    .select('source_intervention_id, employee_id, target_date')
    .gte('target_date', targetFrom)
    .lt('target_date', targetTo);

  if (employeeId) {
    skipQuery = skipQuery.eq('employee_id', employeeId);
  }

  const { data: skipRows, error: skipError } = await skipQuery;

  if (skipError) {
    console.warn('Lecture suppressions de duplications impossible :', skipError.message);
    return;
  }

  const existingSourceIds = new Set(
    (targetRows || [])
      .map((row) => row.duplicated_from_intervention_id)
      .filter(Boolean)
  );
  const existingSlots = new Set((targetRows || []).map(interventionSlotKey));
  const skipped = new Set(
    (skipRows || []).map((row) =>
      [row.source_intervention_id, row.employee_id, row.target_date].join('|')
    )
  );

  const rowsToInsert = [];

  sourceRows.forEach((source) => {
    const targetDate = addDaysToDateValue(source.date, 7);
    if (!targetDate) return;

    const skipKey = [source.id, source.employee_id, targetDate].join('|');
    if (skipped.has(skipKey)) return;
    if (existingSourceIds.has(source.id)) return;

    const targetSlot = interventionSlotKey({
      ...source,
      date: targetDate,
    });
    if (existingSlots.has(targetSlot)) return;

    rowsToInsert.push({
      client_id: source.client_id,
      employee_id: source.employee_id,
      date: targetDate,
      start_time_planned: source.start_time_planned,
      end_time_planned: source.end_time_planned,
      status: 'planned',
      duplicated_from_intervention_id: source.id,
    });
  });

  if (rowsToInsert.length === 0) return;

  const { error: insertError } = await supabase
    .from('interventions')
    .insert(rowsToInsert);

  if (insertError) {
    console.warn('Insertion duplications planning impossible :', insertError.message);
    return;
  }

  if (showMessage) {
    setScheduleMessage(
      `${rowsToInsert.length} intervention(s) dupliquée(s) vers la semaine suivante.`
    );
  }
}

function renderScheduleRows(interventions, monday) {
  if (!scheduleTableBody) return;

  scheduleTableBody.innerHTML = '';

  const rowsByDate = new Map();
  (interventions || []).forEach((row) => {
    const key = row.date || '';
    if (!rowsByDate.has(key)) rowsByDate.set(key, []);
    rowsByDate.get(key).push(row);
  });

  let totalRows = 0;
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  for (let index = 0; index < 7; index += 1) {
    const day = addDays(monday, index);
    const dateValue = dateToInputValue(day);
    const dayRows = rowsByDate.get(dateValue) || [];
    const dayLabel = formatter.format(day);
    const [weekdayLabel] = dayLabel.split(' ');
    const dateLabel = day.toLocaleDateString('fr-FR');

    if (dayRows.length === 0) {
      const emptyTr = document.createElement('tr');
      emptyTr.classList.add('schedule-empty-row');
      emptyTr.innerHTML = `
        <td>${escapeHtml(weekdayLabel)}</td>
        <td>${escapeHtml(dateLabel)}</td>
        <td colspan="4">Aucune intervention prévue.</td>
      `;
      scheduleTableBody.appendChild(emptyTr);
      continue;
    }

    dayRows.forEach((intv, rowIndex) => {
      const tr = document.createElement('tr');
      const isManuallyValidated = validatedInterventions.has(intv.id);
      const businessStatus = isManuallyValidated ? 'validé' : intv.fait || 'en attente';
      const statusLabel = getInterventionDisplayStatus(
        businessStatus,
        intv.actual_start,
        intv.actual_end
      );
      tr.dataset.id = intv.id;
      tr.dataset.fait = businessStatus;
      tr.dataset.employeeId = intv.employee_id || '';
      tr.dataset.date = intv.date || '';
      tr.dataset.duplicatedFrom = intv.duplicated_from_intervention_id || '';

      const isDuplicated = Boolean(intv.duplicated_from_intervention_id);
      const canEdit = canEditPlannedIntervention(businessStatus);
      const canFinalize = canAdminValidateOrDelete(businessStatus);
      const editDisabledAttr = canEdit ? '' : 'disabled';
      const editDisabledClass = canEdit ? '' : ' disabled';
      const finalizeDisabledAttr = canFinalize ? '' : 'disabled';
      const finalizeDisabledClass = canFinalize ? '' : ' disabled';
      const timeLabel = `${intv.start_time_planned || ''} - ${intv.end_time_planned || ''}`;

      if (isDuplicated) {
        tr.classList.add('schedule-duplicated-row');
      }

      tr.innerHTML = `
        <td>${rowIndex === 0 ? escapeHtml(weekdayLabel) : ''}</td>
        <td>${rowIndex === 0 ? escapeHtml(dateLabel) : ''}</td>
        <td>${escapeHtml(timeLabel)}</td>
        <td>${escapeHtml(intv.client_name || '')}</td>
        <td>
          <span class="schedule-status">${escapeHtml(statusLabel)}</span>
          ${isDuplicated ? '<span class="schedule-duplicate-label">dupliquée</span>' : ''}
        </td>
        <td>
          <div class="action-buttons">
            <button class="btn btn-secondary btn-small${editDisabledClass}"
                    data-action="schedule-edit"
                    ${editDisabledAttr}>Modifier</button>
            <button class="btn btn-secondary btn-small${finalizeDisabledClass}"
                    data-action="schedule-delete"
                    ${finalizeDisabledAttr}>Supprimer</button>
            <button class="btn btn-primary btn-small${finalizeDisabledClass}"
                    data-action="schedule-validate"
                    ${finalizeDisabledAttr}>Valider</button>
          </div>
        </td>
      `;
      scheduleTableBody.appendChild(tr);
      totalRows += 1;
    });
  }

  if (totalRows === 0) {
    setScheduleMessage('Aucune intervention prévue pour cette semaine.');
  }
}

async function loadEmployeeSchedule() {
  if (!scheduleTableBody || !scheduleEmployeeSelect || !scheduleWeekStartInput) return;

  setScheduleMessage('');
  const employeeId = scheduleEmployeeSelect.value;
  const monday = normalizeScheduleWeekStart();

  if (!employeeId) {
    scheduleTableBody.innerHTML =
      '<tr><td colspan="6">Choisissez un employé.</td></tr>';
    return;
  }
  if (!monday) {
    scheduleTableBody.innerHTML =
      '<tr><td colspan="6">Choisissez une semaine valide.</td></tr>';
    return;
  }

  const sunday = addDays(monday, 6);
  const nextMonday = addDays(monday, 7);
  const fromDate = dateToInputValue(monday);
  const toDate = dateToInputValue(nextMonday);

  if (scheduleWeekTitle) {
    scheduleWeekTitle.textContent =
      'Planning du ' +
      monday.toLocaleDateString('fr-FR') +
      ' au ' +
      sunday.toLocaleDateString('fr-FR');
  }

  scheduleTableBody.innerHTML =
    '<tr><td colspan="6">Chargement…</td></tr>';

  const { data, error } = await supabase
    .from('interventions_progress_admin')
    .select(`
      id,
      client_id,
      employee_id,
      date,
      start_time_planned,
      end_time_planned,
      client_name,
      employee_name,
      fait,
      actual_start,
      actual_end,
      duplicated_from_intervention_id
    `)
    .eq('employee_id', employeeId)
    .gte('date', fromDate)
    .lt('date', toDate)
    .order('date', { ascending: true })
    .order('start_time_planned', { ascending: true });

  if (error) {
    scheduleTableBody.innerHTML =
      '<tr><td colspan="6">Erreur lors du chargement du planning.</td></tr>';
    setScheduleMessage(error.message ?? 'Chargement impossible.', 'error');
    return;
  }

  renderScheduleRows(data || [], monday);
}

if (scheduleCurrentWeekBtn) {
  scheduleCurrentWeekBtn.addEventListener('click', () => {
    setScheduleCurrentWeekIfEmpty(true);
    resetScheduleForm();
    loadEmployeeSchedule();
  });
}

if (scheduleEmployeeSelect) {
  scheduleEmployeeSelect.addEventListener('change', () => {
    resetScheduleForm();
    loadEmployeeSchedule();
  });
}

if (scheduleWeekStartInput) {
  scheduleWeekStartInput.addEventListener('change', () => {
    normalizeScheduleWeekStart();
    resetScheduleForm();
    loadEmployeeSchedule();
  });
}

if (scheduleNewBtn) {
  scheduleNewBtn.addEventListener('click', () => {
    resetScheduleForm();
    setScheduleFormMessage('Nouvelle intervention pour cette semaine.');
  });
}

if (scheduleForm) {
  scheduleForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setScheduleFormMessage('');

    const id = scheduleInterventionIdInput?.value || null;
    const employee_id = scheduleEmployeeSelect?.value || null;
    const client_id = scheduleClientSelect?.value || null;
    const date = scheduleDateInput?.value || null;
    const start_time_planned = scheduleStartTimeInput?.value || null;
    const end_time_planned = scheduleEndTimeInput?.value || null;

    if (!employee_id || !client_id || !date || !start_time_planned || !end_time_planned) {
      setScheduleFormMessage(
        'Employé, client, date, heure de début et heure de fin sont obligatoires.',
        'error'
      );
      return;
    }

    if (end_time_planned <= start_time_planned) {
      setScheduleFormMessage(
        "L'heure de fin doit être après l'heure de début.",
        'error'
      );
      return;
    }

    try {
      if (id) {
        const { error } = await supabase
          .from('interventions')
          .update({ employee_id, client_id, date, start_time_planned, end_time_planned })
          .eq('id', id);
        if (error) throw error;
        setScheduleFormMessage('Intervention mise à jour dans le planning.');
      } else {
        const { error } = await supabase.from('interventions').insert([
          { employee_id, client_id, date, start_time_planned, end_time_planned, status: 'planned' },
        ]);
        if (error) throw error;
        setScheduleFormMessage('Intervention ajoutée au planning.');
      }

      await loadEmployeeSchedule();
      await loadInterventions();
      syncNeededClientDistances().catch((err) => {
        console.warn('Synchronisation automatique des distances impossible', err);
      });
      resetScheduleForm();
    } catch (err) {
      setScheduleFormMessage(
        err?.message ?? "Erreur lors de l'enregistrement du planning.",
        'error'
      );
    }
  });
}

if (scheduleTableBody) {
  scheduleTableBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.dataset.action;
    if (!action) return;

    const row = target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;

    const fait = row.dataset.fait || 'en attente';

    if (action === 'schedule-edit' && !canEditPlannedIntervention(fait)) {
      setScheduleFormMessage(
        "Cette intervention a déjà un historique : seul Valider ou Supprimer reste possible si elle n'est pas faite.",
        'error'
      );
      return;
    }

    if (
      (action === 'schedule-delete' || action === 'schedule-validate') &&
      !canAdminValidateOrDelete(fait)
    ) {
      setScheduleFormMessage(
        "Cette intervention est déjà faite ou validée.",
        'error'
      );
      return;
    }

    if (action === 'schedule-edit') {
      await loadScheduleLookups();

      const { data, error } = await supabase
        .from('interventions')
        .select('id, client_id, employee_id, date, start_time_planned, end_time_planned')
        .eq('id', id)
        .maybeSingle();

      if (error || !data) {
        setScheduleFormMessage(
          "Impossible de charger l'intervention pour modification.",
          'error'
        );
        return;
      }

      if (scheduleInterventionIdInput) scheduleInterventionIdInput.value = data.id;
      if (scheduleEmployeeSelect) scheduleEmployeeSelect.value = data.employee_id || '';
      if (scheduleClientSelect) scheduleClientSelect.value = data.client_id || '';
      if (scheduleDateInput) scheduleDateInput.value = data.date || '';
      if (scheduleStartTimeInput) scheduleStartTimeInput.value = data.start_time_planned || '';
      if (scheduleEndTimeInput) scheduleEndTimeInput.value = data.end_time_planned || '';
      setScheduleFormMessage("Modification d'une intervention du planning.");
      scheduleForm?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (action === 'schedule-delete') {
      const duplicatedFrom = row.dataset.duplicatedFrom || '';
      const targetDate = row.dataset.date || '';
      const employeeId = row.dataset.employeeId || '';

      if (duplicatedFrom && targetDate && employeeId) {
        const { error: skipError } = await supabase
          .from('intervention_duplication_skips')
          .upsert(
            [
              {
                source_intervention_id: duplicatedFrom,
                employee_id: employeeId,
                target_date: targetDate,
              },
            ],
            { onConflict: 'source_intervention_id,employee_id,target_date' }
          );

        if (skipError) {
          setScheduleFormMessage(
            skipError.message ?? "Impossible d'enregistrer la suppression de la duplication.",
            'error'
          );
          return;
        }
      }

      const { error } = await supabase
        .from('interventions')
        .delete()
        .eq('id', id);

      if (error) {
        setScheduleFormMessage(error.message ?? 'Suppression impossible.', 'error');
        return;
      }

      if (scheduleInterventionIdInput?.value === id) {
        resetScheduleForm();
      }
      setScheduleFormMessage('Intervention supprimée du planning.');
      await loadEmployeeSchedule();
      await loadInterventions();
    } else if (action === 'schedule-validate') {
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from('interventions')
        .update({
          status: 'done',
          saved: true,
          completed_at: nowIso,
        })
        .eq('id', id);

      if (error) {
        setScheduleFormMessage(
          error.message ?? "Impossible de valider l'intervention.",
          'error'
        );
        return;
      }

      validatedInterventions.add(id);
      syncNeededClientDistances().catch((err) => {
        console.warn('Synchronisation automatique des distances impossible', err);
      });
      setScheduleFormMessage('Intervention validée manuellement.');
      await loadEmployeeSchedule();
      await loadInterventions();
    }
  });
}

// --------- Gestion Trajets (client_distances) ---------

function setDistanceFormMessage(text, type = 'info') {
  if (!distanceFormMessage) return;
  distanceFormMessage.textContent = text || '';
  distanceFormMessage.classList.remove('error');
  if (!text) return;
  if (type === 'error') {
    distanceFormMessage.classList.add('error');
  }
}

function resetDistanceForm() {
  if (!distanceIdInput) return;
  distanceIdInput.value = '';
  if (distanceClientASelect) distanceClientASelect.value = '';
  if (distanceClientBSelect) distanceClientBSelect.value = '';
  if (distanceKmInput) distanceKmInput.value = '';
  if (distanceCommentInput) distanceCommentInput.value = '';
  setDistanceFormMessage('');
}

async function loadClientsForDistances() {
  if (!distanceClientASelect || !distanceClientBSelect) return;

  const { data, error } = await supabase
    .from('clients')
    .select('id, name')
    .order('name', { ascending: true });

  if (error) {
    console.error('Erreur chargement clients pour trajets :', error.message);
    return;
  }

  const clients = data || [];

  const mkOptions = () => {
    const frag = document.createDocumentFragment();
    const optDefault = document.createElement('option');
    optDefault.value = '';
    optDefault.textContent = '-- Choisir un client --';
    frag.appendChild(optDefault);

    clients.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || '';
      frag.appendChild(opt);
    });
    return frag;
  };

  distanceClientASelect.innerHTML = '';
  distanceClientBSelect.innerHTML = '';
  distanceClientASelect.appendChild(mkOptions());
  distanceClientBSelect.appendChild(mkOptions());
}

async function loadDistances() {
  if (!distancesTableBody) return;

  distancesTableBody.innerHTML =
    '<tr><td colspan="6">Chargement…</td></tr>';

  const { data, error } = await supabase
    .from('client_distances')
    .select(`
      id,
      distance_km,
      comment,
      created_at,
      client_a:client_a_id ( id, name ),
      client_b:client_b_id ( id, name )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    distancesTableBody.innerHTML =
      '<tr><td colspan="6">Erreur : ' +
      (error.message ?? 'chargement impossible') +
      '</td></tr>';
    return;
  }

  const distances = data || [];
  if (distances.length === 0) {
    distancesTableBody.innerHTML =
      '<tr><td colspan="6">Aucun trajet.</td></tr>';
    return;
  }

  distancesTableBody.innerHTML = '';
  distances.forEach((d) => {
    const tr = document.createElement('tr');
    const aName = d.client_a?.name ?? '';
    const bName = d.client_b?.name ?? '';
    const created = d.created_at
      ? new Date(d.created_at).toLocaleString('fr-FR')
      : '';

    tr.dataset.id = d.id;
    tr.innerHTML = `
      <td>${aName}</td>
      <td>${bName}</td>
      <td>${d.distance_km != null ? Number(d.distance_km).toFixed(2) : ''}</td>
      <td>${d.comment ?? ''}</td>
      <td>${created}</td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-secondary btn-small" data-action="edit-distance">Modifier</button>
          <button class="btn btn-secondary btn-small" data-action="delete-distance">Supprimer</button>
        </div>
      </td>
    `;
    distancesTableBody.appendChild(tr);
  });
}

if (distanceForm) {
  distanceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setDistanceFormMessage('');

    const id = distanceIdInput?.value || null;
    const cA = distanceClientASelect?.value || '';
    const cB = distanceClientBSelect?.value || '';
    const distanceStr = distanceKmInput?.value || '';
    const comment = distanceCommentInput?.value.trim() || null;

    if (!cA || !cB) {
      setDistanceFormMessage('Merci de choisir les deux clients.', 'error');
      return;
    }
    if (cA === cB) {
      setDistanceFormMessage(
        'Les deux clients doivent être différents.',
        'error'
      );
      return;
    }

    let distanceKm = null;
    if (!distanceStr) {
      try {
        setDistanceFormMessage('Calcul de la distance avec Google Maps...');
        distanceKm = await calculateDistanceForClients(cA, cB);
        if (distanceKmInput) distanceKmInput.value = String(distanceKm);
      } catch (err) {
        setDistanceFormMessage(
          err?.message ?? 'Calcul automatique de la distance impossible.',
          'error'
        );
        return;
      }
    } else {
      distanceKm = Number(String(distanceStr).replace(',', '.'));
      if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
        setDistanceFormMessage(
          'La distance doit être un nombre positif.',
          'error'
        );
        return;
      }
    }

    let client_a_id = cA;
    let client_b_id = cB;
    if (client_a_id > client_b_id) {
      const tmp = client_a_id;
      client_a_id = client_b_id;
      client_b_id = tmp;
    }

    try {
      if (id) {
        const { error } = await supabase
          .from('client_distances')
          .update({ client_a_id, client_b_id, distance_km: distanceKm, comment })
          .eq('id', id);
        if (error) throw error;
        setDistanceFormMessage('Trajet mis à jour.');
      } else {
        const { error } = await supabase
          .from('client_distances')
          .insert([{ client_a_id, client_b_id, distance_km: distanceKm, comment }]);
        if (error) throw error;
        setDistanceFormMessage('Trajet enregistré.');
      }

      await loadDistances();
      resetDistanceForm();
    } catch (err) {
      setDistanceFormMessage(
        err?.message ?? "Erreur lors de lenregistrement du trajet.",
        'error'
      );
    }
  });
}

if (distanceResetBtn) {
  distanceResetBtn.addEventListener('click', () => {
    resetDistanceForm();
  });
}

if (distancesTableBody) {
  distancesTableBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.dataset.action;
    if (!action) return;

    const row = target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;

    if (action === 'edit-distance') {
      const { data, error } = await supabase
        .from('client_distances')
        .select('id, client_a_id, client_b_id, distance_km, comment')
        .eq('id', id)
        .maybeSingle();

      if (error || !data) {
        setDistanceFormMessage(
          "Impossible de charger le trajet pour modification.",
          'error'
        );
        return;
      }

      distanceIdInput.value = data.id;
      if (distanceClientASelect && distanceClientBSelect) {
        distanceClientASelect.value = data.client_a_id;
        distanceClientBSelect.value = data.client_b_id;
      }
      if (distanceKmInput)
        distanceKmInput.value =
          data.distance_km != null ? Number(data.distance_km).toString() : '';
      if (distanceCommentInput) distanceCommentInput.value = data.comment ?? '';

      setDistanceFormMessage('Modification du trajet.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (action === 'delete-distance') {
      const { error } = await supabase
        .from('client_distances')
        .delete()
        .eq('id', id);

      if (error) {
        alert(error.message ?? 'Suppression impossible.');
        return;
      }

      if (distanceIdInput && distanceIdInput.value === id) {
        resetDistanceForm();
      }
      await loadDistances();
    }
  });
}

// --------- Gestion Trajets manquants ---------

function setMissingDistancesMessage(text, type = 'info') {
  if (!missingDistancesMessage) return;
  missingDistancesMessage.textContent = text || '';
  missingDistancesMessage.classList.remove('error');
  if (!text) return;
  if (type === 'error') {
    missingDistancesMessage.classList.add('error');
  }
}

function setEmployeeMonthSummaryMessage(text, type = 'info') {
  if (!employeeMonthSummaryMessage) return;
  employeeMonthSummaryMessage.textContent = text || '';
  employeeMonthSummaryMessage.classList.remove('error');
  if (!text) return;
  if (type === 'error') {
    employeeMonthSummaryMessage.classList.add('error');
  }
}

function formatMonthYearLabel(year, monthNumber, fallback = '') {
  const y = Number(year);
  const m = Number(monthNumber);
  if (Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12) {
    return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', {
      month: 'long',
      year: 'numeric',
    });
  }
  return fallback || 'Mois non renseigné';
}

function getMonthParts(value) {
  if (!value) return { year: null, monthNumber: null, key: '', label: '' };
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})/);
  if (!match) {
    return { year: null, monthNumber: null, key: text, label: text };
  }

  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  return {
    year,
    monthNumber,
    key: `${year}-${String(monthNumber).padStart(2, '0')}`,
    label: formatMonthYearLabel(year, monthNumber, text),
  };
}

function getCollapsedSummaryScope(scope) {
  if (!collapsedSummaryMonths[scope]) collapsedSummaryMonths[scope] = {};
  return collapsedSummaryMonths[scope];
}

function getSummaryCollapseKey(type, key) {
  return `${type}:${key}`;
}

function isSummaryGroupCollapsed(scope, type, key) {
  return getCollapsedSummaryScope(scope)[getSummaryCollapseKey(type, key)] === true;
}

function saveCollapsedSummaryMonths() {
  try {
    localStorage.setItem(
      MONTH_SUMMARY_COLLAPSE_KEY,
      JSON.stringify(collapsedSummaryMonths)
    );
  } catch (e) {
    console.error('Erreur sauvegarde collapsedSummaryMonths', e);
  }
}

function setSummaryGroupCollapsed(scope, type, key, collapsed) {
  const scopeState = getCollapsedSummaryScope(scope);
  const collapseKey = getSummaryCollapseKey(type, key);
  if (collapsed) {
    scopeState[collapseKey] = true;
  } else {
    delete scopeState[collapseKey];
  }
  saveCollapsedSummaryMonths();
}

function appendSummaryGroupRow(tbody, label, colspan, groupKey, scope, type) {
  const collapsed = isSummaryGroupCollapsed(scope, type, groupKey);
  const tr = document.createElement('tr');
  tr.className = `${type}-group-row`;
  tr.dataset.summaryGroupType = type;
  tr.dataset.groupKey = groupKey;
  tr.innerHTML = `
    <td colspan="${colspan}">
      <button type="button" class="summary-toggle ${type}-toggle" data-action="toggle-summary-group" aria-expanded="${!collapsed}">
        <span class="summary-toggle-icon">${collapsed ? '>' : 'v'}</span>
        <span>${label}</span>
      </button>
    </td>
  `;
  tbody.appendChild(tr);
}

function updateSummaryGroupVisibility(tbody, scope) {
  const collapsedYears = new Set();
  const collapsedMonths = new Set();
  const collapsedWeeks = new Set();
  tbody.querySelectorAll('tr.year-group-row').forEach((row) => {
    const yearKey = row.dataset.groupKey;
    if (!yearKey) return;
    const button = row.querySelector('button[data-action="toggle-summary-group"]');
    const collapsed = isSummaryGroupCollapsed(scope, 'year', yearKey);
    if (button) {
      button.setAttribute('aria-expanded', String(!collapsed));
      const icon = button.querySelector('.summary-toggle-icon');
      if (icon) icon.textContent = collapsed ? '>' : 'v';
    }
    if (collapsed) collapsedYears.add(yearKey);
  });

  tbody.querySelectorAll('tr.month-group-row').forEach((row) => {
    const yearKey = row.dataset.yearKey;
    const monthKey = row.dataset.groupKey;
    if (!yearKey || !monthKey) return;
    const hiddenByYear = collapsedYears.has(yearKey);
    const collapsed = isSummaryGroupCollapsed(scope, 'month', monthKey);
    row.classList.toggle('hidden', hiddenByYear);
    if (collapsed) collapsedMonths.add(monthKey);
    const button = row.querySelector('button[data-action="toggle-summary-group"]');
    if (button) {
      button.setAttribute('aria-expanded', String(!collapsed));
      const icon = button.querySelector('.summary-toggle-icon');
      if (icon) icon.textContent = collapsed ? '>' : 'v';
    }
  });

  tbody.querySelectorAll('tr.week-group-row').forEach((row) => {
    const yearKey = row.dataset.yearKey;
    const monthKey = row.dataset.monthKey;
    const weekKey = row.dataset.groupKey;
    if (!weekKey) return;
    const hiddenByParent =
      (yearKey && collapsedYears.has(yearKey)) ||
      (monthKey && collapsedMonths.has(monthKey));
    const collapsed = isSummaryGroupCollapsed(scope, 'week', weekKey);
    row.classList.toggle('hidden', Boolean(hiddenByParent));
    if (collapsed) collapsedWeeks.add(weekKey);
    const button = row.querySelector('button[data-action="toggle-summary-group"]');
    if (button) {
      button.setAttribute('aria-expanded', String(!collapsed));
      const icon = button.querySelector('.summary-toggle-icon');
      if (icon) icon.textContent = collapsed ? '>' : 'v';
    }
  });

  tbody.querySelectorAll('tr.summary-detail-row').forEach((row) => {
    const yearKey = row.dataset.yearKey;
    const monthKey = row.dataset.monthKey;
    const weekKey = row.dataset.weekKey;
    const hidden =
      (yearKey && collapsedYears.has(yearKey)) ||
      (monthKey && collapsedMonths.has(monthKey)) ||
      (weekKey && collapsedWeeks.has(weekKey));
    row.classList.toggle('hidden', Boolean(hidden));
  });
}

function toggleSummaryGroup(tbody, groupKey, type, button, scope) {
  const isExpanded = button.getAttribute('aria-expanded') !== 'false';
  const nextExpanded = !isExpanded;
  setSummaryGroupCollapsed(scope, type, groupKey, !nextExpanded);
  updateSummaryGroupVisibility(tbody, scope);
}

function setupSummaryGroupToggle(tbody, scope) {
  if (!tbody) return;
  tbody.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('button[data-action="toggle-summary-group"]');
    if (!button) return;
    const row = button.closest('tr');
    const groupKey = row?.dataset.groupKey;
    const type = row?.dataset.summaryGroupType;
    if (!groupKey || !type) return;
    toggleSummaryGroup(tbody, groupKey, type, button, scope);
  });
}

setupSummaryGroupToggle(employeeMonthSummaryTableBody, 'employee');
setupSummaryGroupToggle(clientMonthlyBilanTableBody, 'client');
setupSummaryGroupToggle(interventionBilanTableBody, 'intervention-bilan');

function getInterventionBilanWeekInfo(dateStr) {
  if (!dateStr) {
    return { weekKey: 'sans-date', groupDate: null, label: 'Sans date' };
  }

  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return { weekKey: 'sans-date', groupDate: null, label: 'Sans date' };
  }

  const monday = new Date(date);
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const weekKey = [
    monday.getFullYear(),
    String(monday.getMonth() + 1).padStart(2, '0'),
    String(monday.getDate()).padStart(2, '0'),
  ].join('-');

  return {
    weekKey,
    groupDate: weekKey,
    label: `Semaine du ${monday.toLocaleDateString('fr-FR')} au ${sunday.toLocaleDateString('fr-FR')}`,
  };
}

async function loadInterventionBilanLookups() {
  if (!interventionBilanClientSelect || !interventionBilanEmployeeSelect) return;

  const selectedClient = interventionBilanClientSelect.value;
  const selectedEmployee = interventionBilanEmployeeSelect.value;
  const [{ data: clients, error: clientsError }, { data: employees, error: employeesError }] =
    await Promise.all([
      supabase.from('clients').select('id, name').order('name', { ascending: true }),
      supabase
        .from('employees')
        .select('id, first_name, last_name')
        .order('last_name', { ascending: true })
        .order('first_name', { ascending: true }),
    ]);

  if (!clientsError) {
    interventionBilanClientSelect.innerHTML =
      '<option value="">-- Choisir un client --</option>';
    (clients || []).forEach((client) => {
      const option = document.createElement('option');
      option.value = client.id;
      option.textContent = client.name || '';
      interventionBilanClientSelect.appendChild(option);
    });
    interventionBilanClientSelect.value = selectedClient;
  }

  if (!employeesError) {
    interventionBilanEmployeeSelect.innerHTML =
      '<option value="">-- Choisir un employé --</option>';
    (employees || []).forEach((employee) => {
      const option = document.createElement('option');
      option.value = employee.id;
      option.textContent = `${employee.first_name ?? ''} ${employee.last_name ?? ''}`.trim();
      interventionBilanEmployeeSelect.appendChild(option);
    });
    interventionBilanEmployeeSelect.value = selectedEmployee;
  }
}

async function loadInterventionBilan() {
  if (!interventionBilanTableBody) return;

  interventionBilanTableBody.innerHTML = '<tr><td colspan="7">Chargement…</td></tr>';
  if (interventionBilanMessage) {
    interventionBilanMessage.textContent = '';
    interventionBilanMessage.classList.remove('error');
  }

  const { data, error } = await supabase
    .from('interventions_progress_admin')
    .select(`
      id,
      date,
      client_name,
      employee_name,
      start_time_planned,
      end_time_planned,
      actual_start,
      actual_end,
      fait,
      client_id,
      employee_id,
      duplicated_from_intervention_id
    `)
    .order('date', { ascending: true })
    .order('start_time_planned', { ascending: true });

  if (error) {
    interventionBilanTableBody.innerHTML = `<tr><td colspan="7">Erreur : ${error.message || 'chargement impossible'}</td></tr>`;
    if (interventionBilanMessage) {
      interventionBilanMessage.textContent = error.message || 'Chargement impossible.';
      interventionBilanMessage.classList.add('error');
    }
    return;
  }

  const interventions = data || [];
  if (interventions.length === 0) {
    interventionBilanTableBody.innerHTML = '<tr><td colspan="7">Aucune intervention.</td></tr>';
    return;
  }

  interventionBilanTableBody.innerHTML = '';
  let currentYearKey = null;
  let currentMonthKey = null;
  let currentWeekKey = null;

  interventions.forEach((intervention) => {
    const week = getInterventionBilanWeekInfo(intervention.date);
    const month = getMonthParts(week.groupDate || intervention.date);
    const yearKey = month.year == null ? 'annee-inconnue' : String(month.year);
    const monthKey = month.key || 'mois-inconnu';
    const weekKey = `${monthKey}:${week.weekKey}`;

    if (yearKey !== currentYearKey) {
      currentYearKey = yearKey;
      currentMonthKey = null;
      currentWeekKey = null;
      appendSummaryGroupRow(
        interventionBilanTableBody,
        month.year == null ? 'Année non renseignée' : yearKey,
        7,
        yearKey,
        'intervention-bilan',
        'year'
      );
    }

    if (monthKey !== currentMonthKey) {
      currentMonthKey = monthKey;
      currentWeekKey = null;
      appendSummaryGroupRow(
        interventionBilanTableBody,
        month.label || 'Mois non renseigné',
        7,
        monthKey,
        'intervention-bilan',
        'month'
      );
      const monthRow = interventionBilanTableBody.lastElementChild;
      if (monthRow) monthRow.dataset.yearKey = yearKey;
    }

    if (weekKey !== currentWeekKey) {
      currentWeekKey = weekKey;
      appendSummaryGroupRow(
        interventionBilanTableBody,
        week.label,
        7,
        weekKey,
        'intervention-bilan',
        'week'
      );
      const weekRow = interventionBilanTableBody.lastElementChild;
      if (weekRow) {
        weekRow.dataset.yearKey = yearKey;
        weekRow.dataset.monthKey = monthKey;
      }
    }

    const row = document.createElement('tr');
    row.classList.add('summary-detail-row');
    row.dataset.yearKey = yearKey;
    row.dataset.monthKey = monthKey;
    row.dataset.weekKey = weekKey;
    row.dataset.id = intervention.id;
    row.dataset.employeeId = intervention.employee_id || '';
    row.dataset.date = intervention.date || '';
    row.dataset.duplicatedFrom = intervention.duplicated_from_intervention_id || '';
    const faitRaw = intervention.fait ?? 'en attente';
    const isManuallyValidated = validatedInterventions.has(intervention.id);
    const fait = isManuallyValidated ? 'validé' : faitRaw;
    const displayStatus = isManuallyValidated
      ? 'validé'
      : getInterventionDisplayStatus(
          fait,
          intervention.actual_start,
          intervention.actual_end
        );
    row.dataset.fait = fait;
    const duplicated = Boolean(intervention.duplicated_from_intervention_id);
    const canEdit = !isManuallyValidated && canEditPlannedIntervention(fait);
    const canFinalize = !isManuallyValidated && canAdminValidateOrDelete(fait);
    const editDisabledAttr = canEdit ? '' : 'disabled';
    const editDisabledClass = canEdit ? '' : ' disabled';
    const finalizeDisabledAttr = canFinalize ? '' : 'disabled';
    const finalizeDisabledClass = canFinalize ? '' : ' disabled';
    if (duplicated) row.classList.add('intervention-duplicated-row');
    row.innerHTML = `
      <td>${intervention.client_name || ''}</td>
      <td>${intervention.employee_name || ''}</td>
      <td>${intervention.date ? new Date(`${intervention.date}T00:00:00`).toLocaleDateString('fr-FR') : ''}</td>
      <td>${intervention.start_time_planned || ''}</td>
      <td>${intervention.end_time_planned || ''}</td>
      <td>
        ${displayStatus}
        ${duplicated ? '<span class="schedule-duplicate-label">dupliquée</span>' : ''}
      </td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-secondary btn-small${editDisabledClass}"
                  data-action="edit"
                  ${editDisabledAttr}>Modifier</button>
          <button class="btn btn-secondary btn-small${finalizeDisabledClass}"
                  data-action="delete"
                  ${finalizeDisabledAttr}>Supprimer</button>
          <button class="btn btn-primary btn-small${finalizeDisabledClass}"
                  data-action="validate"
                  ${finalizeDisabledAttr}>Valider</button>
        </div>
      </td>
    `;
    interventionBilanTableBody.appendChild(row);
  });

  updateSummaryGroupVisibility(interventionBilanTableBody, 'intervention-bilan');
}

if (interventionBilanForm) {
  interventionBilanForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setInterventionBilanFormMessage('');

    const id = interventionBilanIdInput.value || null;
    const client_id = interventionBilanClientSelect.value || null;
    const employee_id = interventionBilanEmployeeSelect.value || null;
    const date = interventionBilanDateInput.value || null;
    const start_time_planned = interventionBilanStartTimeInput.value || null;
    const end_time_planned = interventionBilanEndTimeInput.value || null;

    if (!client_id || !employee_id || !date) {
      setInterventionBilanFormMessage('Client, employé et date sont obligatoires.', 'error');
      return;
    }

    try {
      let successMessage;
      if (id) {
        const { error } = await supabase
          .from('interventions')
          .update({ client_id, employee_id, date, start_time_planned, end_time_planned })
          .eq('id', id);
        if (error) throw error;
        successMessage = 'Intervention mise à jour.';
      } else {
        const { error } = await supabase.from('interventions').insert([
          { client_id, employee_id, date, start_time_planned, end_time_planned, status: 'planned' },
        ]);
        if (error) throw error;
        successMessage = 'Intervention ajoutée.';
      }

      resetInterventionBilanForm();
      setInterventionBilanFormMessage(successMessage);
      await loadInterventionBilan();
      syncNeededClientDistances().catch((err) => {
        console.warn('Synchronisation automatique des distances impossible', err);
      });
    } catch (err) {
      setInterventionBilanFormMessage(
        err?.message ?? "Erreur lors de l'enregistrement de l'intervention.",
        'error'
      );
    }
  });
}

if (interventionBilanResetBtn) {
  interventionBilanResetBtn.addEventListener('click', resetInterventionBilanForm);
}

if (interventionBilanTableBody) {
  interventionBilanTableBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.dataset.action;
    if (!['edit', 'delete', 'validate'].includes(action)) return;

    const row = target.closest('tr');
    const id = row?.dataset.id;
    if (!row || !id) return;

    const fait = row.dataset.fait || 'en attente';
    if (action === 'edit' && !canEditPlannedIntervention(fait)) {
      setInterventionBilanFormMessage(
        "Cette intervention a déjà un historique : seul Valider ou Supprimer reste possible si elle n'est pas faite.",
        'error'
      );
      return;
    }
    if ((action === 'delete' || action === 'validate') && !canAdminValidateOrDelete(fait)) {
      setInterventionBilanFormMessage('Cette intervention est déjà faite ou validée.', 'error');
      return;
    }

    if (action === 'edit') {
      await loadInterventionBilanLookups();
      const { data, error } = await supabase
        .from('interventions')
        .select('id, client_id, employee_id, date, start_time_planned, end_time_planned')
        .eq('id', id)
        .maybeSingle();

      if (error || !data) {
        setInterventionBilanFormMessage(
          "Impossible de charger l'intervention pour modification.",
          'error'
        );
        return;
      }

      interventionBilanIdInput.value = data.id;
      interventionBilanClientSelect.value = data.client_id || '';
      interventionBilanEmployeeSelect.value = data.employee_id || '';
      interventionBilanDateInput.value = data.date || '';
      interventionBilanStartTimeInput.value = data.start_time_planned || '';
      interventionBilanEndTimeInput.value = data.end_time_planned || '';
      setInterventionBilanFormMessage("Modification de l'intervention.");
      interventionBilanForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (action === 'delete') {
      const duplicatedFrom = row.dataset.duplicatedFrom || '';
      const targetDate = row.dataset.date || '';
      const employeeId = row.dataset.employeeId || '';

      if (duplicatedFrom && targetDate && employeeId) {
        const { error: skipError } = await supabase
          .from('intervention_duplication_skips')
          .upsert(
            [{ source_intervention_id: duplicatedFrom, employee_id: employeeId, target_date: targetDate }],
            { onConflict: 'source_intervention_id,employee_id,target_date' }
          );
        if (skipError) {
          setInterventionBilanFormMessage(
            skipError.message ?? "Impossible d'enregistrer la suppression de la duplication.",
            'error'
          );
          return;
        }
      }

      const { error } = await supabase.from('interventions').delete().eq('id', id);
      if (error) {
        setInterventionBilanFormMessage(error.message ?? 'Suppression impossible.', 'error');
        return;
      }
      if (interventionBilanIdInput.value === id) resetInterventionBilanForm();
      setInterventionBilanFormMessage('Intervention supprimée.');
      await loadInterventionBilan();
      return;
    }

    try {
      const { error } = await supabase
        .from('interventions')
        .update({ status: 'done', saved: true, completed_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;

      validatedInterventions.add(id);
      setInterventionBilanFormMessage('Intervention validée manuellement.');
      await loadInterventionBilan();
      syncNeededClientDistances().catch((err) => {
        console.warn('Synchronisation automatique des distances impossible', err);
      });
    } catch (err) {
      setInterventionBilanFormMessage(
        err?.message ?? "Erreur inconnue lors de la validation de l'intervention.",
        'error'
      );
    }
  });
}

async function loadEmployeeMonthSummary() {
  if (!employeeMonthSummaryTableBody) return;

  employeeMonthSummaryTableBody.innerHTML =
    '<tr><td colspan="6">Chargement…</td></tr>';
  setEmployeeMonthSummaryMessage('');

  try {
    const { data, error } = await supabase
      .from('employee_month_summary')
      .select(
        'employee_id, first_name, last_name, month, hours_worked, km_travelled_km, trips_with_missing_distance'
      )
      .order('month', { ascending: false });

    if (error) throw error;

    if (!data || data.length === 0) {
      employeeMonthSummaryTableBody.innerHTML =
        '<tr><td colspan="6">Aucun bilan trouvé.</td></tr>';
      return;
    }

    employeeMonthSummaryTableBody.innerHTML = '';
    let currentYearKey = null;
    let currentMonthKey = null;

    data.forEach((row) => {
      const tr = document.createElement('tr');
      const monthParts = getMonthParts(row.month);
      const monthLabel = monthParts.label;
      const yearKey =
        monthParts.year == null ? 'annee-inconnue' : String(monthParts.year);
      const yearLabel =
        monthParts.year == null ? 'Année non renseignée' : String(monthParts.year);

      if (yearKey !== currentYearKey) {
        currentYearKey = yearKey;
        currentMonthKey = null;
        appendSummaryGroupRow(
          employeeMonthSummaryTableBody,
          yearLabel,
          6,
          currentYearKey,
          'employee',
          'year'
        );
      }

      if (monthParts.key !== currentMonthKey) {
        currentMonthKey = monthParts.key;
        appendSummaryGroupRow(
          employeeMonthSummaryTableBody,
          monthLabel,
          6,
          currentMonthKey,
          'employee',
          'month'
        );
        const monthGroupRow = employeeMonthSummaryTableBody.lastElementChild;
        if (monthGroupRow) monthGroupRow.dataset.yearKey = currentYearKey;
      }
      tr.classList.add('summary-detail-row');
      tr.dataset.yearKey = currentYearKey;
      tr.dataset.monthKey = currentMonthKey;

      const hours =
        row.hours_worked == null
          ? ''
          : Number(row.hours_worked).toLocaleString('fr-FR', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });

      const km =
        row.km_travelled_km == null
          ? ''
          : Number(row.km_travelled_km).toLocaleString('fr-FR', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });

      const missingTrips =
        row.trips_with_missing_distance == null
          ? 0
          : Number(row.trips_with_missing_distance);

      tr.innerHTML = `
        <td></td>
        <td>${row.first_name ?? ''}</td>
        <td>${row.last_name ?? ''}</td>
        <td>${hours}</td>
        <td>${km}</td>
        <td>${missingTrips}</td>
      `;

      employeeMonthSummaryTableBody.appendChild(tr);
    });
    updateSummaryGroupVisibility(employeeMonthSummaryTableBody, 'employee');
  } catch (err) {
    console.error('Erreur loadEmployeeMonthSummary', err);
    employeeMonthSummaryTableBody.innerHTML =
      '<tr><td colspan="6">Erreur lors du chargement du bilan heure employé.</td></tr>';
    setEmployeeMonthSummaryMessage(err.message ?? 'Erreur inconnue.', 'error');
  }
}


function setClientMonthlyBilanMessage(text, type = 'info') {
  if (!clientMonthlyBilanMessage) return;
  clientMonthlyBilanMessage.textContent = text || '';
  clientMonthlyBilanMessage.classList.remove('error');
  if (!text) return;
  if (type === 'error') {
    clientMonthlyBilanMessage.classList.add('error');
  }
}

async function loadClientMonthlyBilan() {
  if (!clientMonthlyBilanTableBody) return;

  clientMonthlyBilanTableBody.innerHTML =
    '<tr><td colspan="4">Chargement…</td></tr>';
  setClientMonthlyBilanMessage('');

  try {
    const { data, error } = await supabase
      .from('client_monthly_bilan')
      .select('client_id, client_name, month, year, month_number, hours_worked')
      .order('year', { ascending: false })
      .order('month_number', { ascending: false })
      .order('client_name', { ascending: true });

    if (error) throw error;

    if (!data || data.length === 0) {
      clientMonthlyBilanTableBody.innerHTML =
        '<tr><td colspan="4">Aucun bilan trouvé.</td></tr>';
      return;
    }

    clientMonthlyBilanTableBody.innerHTML = '';
    let currentYearKey = null;
    let currentMonthKey = null;

    data.forEach((row) => {
      const tr = document.createElement('tr');

      const monthLabel =
        row.month_number == null
          ? ''
          : Number(row.month_number).toLocaleString('fr-FR', {
              minimumIntegerDigits: 2,
              useGrouping: false,
            });

      const yearLabel = row.year == null ? '' : String(row.year);
      const yearKey = yearLabel || 'annee-inconnue';
      const displayYearLabel = yearLabel || 'Année non renseignée';
      const groupKey = `${yearLabel}-${monthLabel}`;
      const groupLabel = formatMonthYearLabel(
        row.year,
        row.month_number,
        [monthLabel, yearLabel].filter(Boolean).join('/')
      );

      if (yearKey !== currentYearKey) {
        currentYearKey = yearKey;
        currentMonthKey = null;
        appendSummaryGroupRow(
          clientMonthlyBilanTableBody,
          displayYearLabel,
          4,
          currentYearKey,
          'client',
          'year'
        );
      }

      if (groupKey !== currentMonthKey) {
        currentMonthKey = groupKey;
        appendSummaryGroupRow(
          clientMonthlyBilanTableBody,
          groupLabel,
          4,
          currentMonthKey,
          'client',
          'month'
        );
        const monthGroupRow = clientMonthlyBilanTableBody.lastElementChild;
        if (monthGroupRow) monthGroupRow.dataset.yearKey = currentYearKey;
      }
      tr.classList.add('summary-detail-row');
      tr.dataset.yearKey = currentYearKey;
      tr.dataset.monthKey = currentMonthKey;

      const hours =
        row.hours_worked == null
          ? ''
          : Number(row.hours_worked).toLocaleString('fr-FR', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });

      tr.innerHTML = `
        <td>${monthLabel}</td>
        <td>${yearLabel}</td>
        <td>${row.client_name ?? ''}</td>
        <td>${hours}</td>
      `;

      clientMonthlyBilanTableBody.appendChild(tr);
    });
    updateSummaryGroupVisibility(clientMonthlyBilanTableBody, 'client');
  } catch (err) {
    console.error('Erreur loadClientMonthlyBilan', err);
    clientMonthlyBilanTableBody.innerHTML =
      '<tr><td colspan="4">Erreur lors du chargement du bilan heure client.</td></tr>';
    setClientMonthlyBilanMessage(err.message ?? 'Erreur inconnue.', 'error');
  }
}

async function loadMissingDistances() {
  if (!missingDistancesTableBody) return;

  missingDistancesTableBody.innerHTML =
    '<tr><td colspan="4">Chargement…</td></tr>';
  setMissingDistancesMessage('');

  try {
    const syncResult = await syncNeededClientDistances({ silent: false });
    if (syncResult?.inserted > 0) {
      setMissingDistancesMessage(
        `${syncResult.inserted} distance(s) necessaire(s) calculee(s) automatiquement.`
      );
    }
    if (syncResult?.errors?.length) {
      setMissingDistancesMessage(
        `${syncResult.errors.length} distance(s) n'ont pas pu etre calculee(s) automatiquement.`,
        'error'
      );
    }
  } catch (err) {
    setMissingDistancesMessage(
      err?.message ?? 'Synchronisation automatique des distances impossible.',
      'error'
    );
  }

  const { data, error } = await supabase
    .from('missing_client_distances')
    .select('*')
    .order('client_a_name', { ascending: true })
    .order('client_b_name', { ascending: true });

  if (error) {
    missingDistancesTableBody.innerHTML =
      '<tr><td colspan="4">Erreur : ' +
      (error.message ?? 'chargement impossible') +
      '</td></tr>';
    setMissingDistancesMessage(
      error.message ?? 'Erreur lors du chargement des trajets manquants.',
      'error'
    );
    return;
  }

  const rows = data || [];
  if (rows.length === 0) {
    missingDistancesTableBody.innerHTML =
      '<tr><td colspan="4">Aucun trajet manquant.</td></tr>';
    return;
  }

  missingDistancesTableBody.innerHTML = '';
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.dataset.clientAId = r.client_a_id;
    tr.dataset.clientBId = r.client_b_id;

    tr.innerHTML = `
      <td>${r.client_a_name ?? ''}</td>
      <td>${r.client_b_name ?? ''}</td>
      <td>
        <input type="number"
               class="missing-distance-input"
               min="0"
               step="0.1"
               placeholder="km" />
      </td>
      <td>
        <button class="btn btn-secondary btn-small" data-action="calculate-missing-distance">
          Calculer
        </button>
        <button class="btn btn-primary btn-small" data-action="save-missing-distance">
          Enregistrer
        </button>
      </td>
    `;
    missingDistancesTableBody.appendChild(tr);
  });
}

if (missingDistancesTableBody) {
  missingDistancesTableBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    if (
      action !== 'save-missing-distance' &&
      action !== 'calculate-missing-distance'
    ) return;

    const row = target.closest('tr');
    if (!row) return;

    const clientAId = row.dataset.clientAId;
    const clientBId = row.dataset.clientBId;
    if (!clientAId || !clientBId) return;

    const input = row.querySelector('.missing-distance-input');
    if (!input) return;

    let raw = input.value.trim();
    if (!raw || action === 'calculate-missing-distance') {
      try {
        setMissingDistancesMessage('Calcul de la distance avec Google Maps...');
        const calculatedKm = await calculateDistanceForClients(clientAId, clientBId);
        input.value = String(calculatedKm);
        raw = input.value.trim();
        setMissingDistancesMessage('Distance calculee. Cliquez sur Enregistrer.');
        if (action === 'calculate-missing-distance') return;
      } catch (err) {
        setMissingDistancesMessage(
          err?.message ?? 'Calcul automatique de la distance impossible.',
          'error'
        );
        return;
      }
    }

    if (!raw) {
      setMissingDistancesMessage('Merci de saisir une distance en km.', 'error');
      return;
    }

    let distanceKm = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
      setMissingDistancesMessage(
        'La distance doit être un nombre positif.',
        'error'
      );
      return;
    }

    let a_id = clientAId;
    let b_id = clientBId;
    if (a_id > b_id) {
      const tmp = a_id;
      a_id = b_id;
      b_id = tmp;
    }

    try {
      const { error } = await supabase.from('client_distances').insert([
        {
          client_a_id: a_id,
          client_b_id: b_id,
          distance_km: distanceKm,
        },
      ]);

      if (error) {
        setMissingDistancesMessage(
          error.message ?? "Impossible d'enregistrer la distance.",
          'error'
        );
        return;
      }

      setMissingDistancesMessage('Distance enregistrée.');
      await loadMissingDistances();
      if (distancesTableBody) {
        await loadDistances();
      }
    } catch (err) {
      setMissingDistancesMessage(
        err?.message ?? 'Erreur inconnue lors de la sauvegarde.',
        'error'
      );
    }
  });
}

// --------- Gestion Pointages ---------

async function loadPointages() {
  if (!pointagesTableBody) return;

  const hadRowsBefore = pointagesTableBody.querySelector('tr');

  const { data, error } = await supabase
    .from('pointages')
    .select(`
      id,
      type,
      timestamp,
      latitude,
      longitude,
      accuracy,
      created_at,
      intervention:interventions(
        date,
        client:clients(name),
        employee:employees(first_name, last_name)
      )
    `)
    .order('timestamp', { ascending: false });

  if (error) {
    if (!hadRowsBefore) {
      pointagesTableBody.innerHTML =
        '<tr><td colspan="9">Erreur : ' +
        (error.message ?? 'chargement impossible') +
        '</td></tr>';
    }
    return;
  }

  const pointages = data ?? [];

  if (pointages.length === 0) {
    if (!hadRowsBefore) {
      pointagesTableBody.innerHTML =
        '<tr><td colspan="9">Aucun pointage.</td></tr>';
    }
    return;
  }

  pointagesTableBody.innerHTML = '';

  pointages.forEach((p) => {
    const tr = document.createElement('tr');

    const dateInterv = p.intervention?.date
      ? new Date(p.intervention.date).toLocaleDateString('fr-FR')
      : '';

    const employeeName = p.intervention?.employee
      ? `${p.intervention.employee.first_name ?? ''} ${
          p.intervention.employee.last_name ?? ''
        }`.trim()
      : '';

    const clientName = p.intervention?.client?.name ?? '';

    const pointageTime = p.timestamp
      ? new Date(p.timestamp).toLocaleString('fr-FR')
      : '';

    tr.dataset.id = p.id;
    tr.innerHTML = `
      <td>${dateInterv}</td>
      <td>${employeeName}</td>
      <td>${clientName}</td>
      <td>${p.type ?? ''}</td>
      <td>${pointageTime}</td>
      <td>${p.latitude != null ? p.latitude.toFixed(5) : ''}</td>
      <td>${p.longitude != null ? p.longitude.toFixed(5) : ''}</td>
      <td>${p.accuracy != null ? p.accuracy.toFixed(1) : ''}</td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-secondary btn-small" data-action="delete">Supprimer</button>
        </div>
      </td>
    `;
    pointagesTableBody.appendChild(tr);
  });
}

// --------- Auto-refresh ---------

let interventionsInterval = null;
let scheduleInterval = null;
let interventionBilanInterval = null;
let pointagesInterval = null;

function startAutoRefreshInterventions() {
  if (interventionsInterval) clearInterval(interventionsInterval);
  interventionsInterval = setInterval(loadInterventions, 10000);
}

function stopAutoRefreshInterventions() {
  if (interventionsInterval) clearInterval(interventionsInterval);
}

function startAutoRefreshSchedule() {
  if (scheduleInterval) clearInterval(scheduleInterval);
  scheduleInterval = setInterval(loadEmployeeSchedule, 10000);
}

function stopAutoRefreshSchedule() {
  if (scheduleInterval) clearInterval(scheduleInterval);
}

function startAutoRefreshInterventionBilan() {
  if (interventionBilanInterval) clearInterval(interventionBilanInterval);
  interventionBilanInterval = setInterval(loadInterventionBilan, 10000);
}

function stopAutoRefreshInterventionBilan() {
  if (interventionBilanInterval) clearInterval(interventionBilanInterval);
}

function startAutoRefreshPointages() {
  if (pointagesInterval) clearInterval(pointagesInterval);
  pointagesInterval = setInterval(loadPointages, 10000);
}

function stopAutoRefreshPointages() {
  if (pointagesInterval) clearInterval(pointagesInterval);
}

if (pointagesTableBody) {
  pointagesTableBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.dataset.action;
    if (action !== 'delete') return;

    const row = target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;

    const { error } = await supabase
      .from('pointages')
      .delete()
      .eq('id', id);

    if (error) {
      alert(error.message ?? 'Suppression impossible.');
      return;
    }

    await loadPointages();
    startAutoRefreshPointages();
  });
}

restoreSession();
