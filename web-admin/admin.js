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

// --- LocationIQ (géocodage adresse → coordonnées) ---
const LOCATIONIQ_TOKEN = 'pk.9d814555a5670ab2b6030dabe3f2bc93';

async function geocodeAddress(address) {
  try {
    if (!address) return { latitude: null, longitude: null };
    const url =
      'https://eu1.locationiq.com/v1/search?format=json&limit=1&key=' +
      encodeURIComponent(LOCATIONIQ_TOKEN) +
      '&q=' +
      encodeURIComponent(address);

    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error('Erreur LocationIQ (' + res.status + ')');
    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) {
      throw new Error('Adresse introuvable');
    }
    const top = json[0];
    const latitude = top && top.lat ? Number(top.lat) : null;
    const longitude = top && top.lon ? Number(top.lon) : null;
    if (
      latitude == null ||
      Number.isNaN(latitude) ||
      longitude == null ||
      Number.isNaN(longitude)
    ) {
      throw new Error('Coordonnées invalides');
    }
    return { latitude, longitude };
  } catch (e) {
    console.warn('[LocationIQ] Géocodage impossible :', e?.message || e);
    return {
      latitude: null,
      longitude: null,
      _geocodeError: e?.message || String(e),
    };
  }
}

// Sections / login
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
const employeePasswordInput = document.getElementById('employee-password');
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

function showLogin() {
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
}

async function restoreSession() {
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

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.classList.add('hidden');
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

function resetEmployeeForm() {
  employeeIdInput.value = '';
  employeeFirstNameInput.value = '';
  employeeLastNameInput.value = '';
  employeeAddressInput.value = '';
  employeePhoneInput.value = '';
  employeeEmailInput.value = '';
  employeePasswordInput.value = '';
  setEmployeeFormMessage('');
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
    const password = employeePasswordInput.value.trim() || null;

    if (!first_name || !last_name) {
      setEmployeeFormMessage('Prénom et nom sont obligatoires.', 'error');
      return;
    }

    if (!id && (!email || !password)) {
      setEmployeeFormMessage(
        "Pour créer un employé, l'email et le mot de passe sont obligatoires.",
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
        setEmployeeFormMessage(
          "Employé mis à jour. Le mot de passe n'a pas été modifié depuis cette interface."
        );
      } else {
        const { data: signUpData, error: signUpError } =
          await supabaseAuthAdmin.auth.signUp({
            email,
            password,
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

        setEmployeeFormMessage('Employé créé avec son compte utilisateur.');
      }

      await loadEmployees();
      resetEmployeeForm();
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

    if (action === 'edit') {
      const cells = row.querySelectorAll('td');
      employeeIdInput.value = id;
      employeeFirstNameInput.value = (cells[0].textContent || '').trim();
      employeeLastNameInput.value = (cells[1].textContent || '').trim();
      employeeAddressInput.value = (cells[2].textContent || '').trim();
      employeePhoneInput.value = (cells[3].textContent || '').trim();
      employeeEmailInput.value = (cells[4].textContent || '').trim();
      employeePasswordInput.value = '';
      setEmployeeFormMessage(
        "Modification d'un employé existant : le mot de passe n'est pas modifié ici. Utiliser le dashboard Supabase pour le changer."
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
      if (address) {
        setClientFormMessage('Géocodage de l’adresse…');
        const geo = await geocodeAddress(address);
        latitude = geo.latitude;
        longitude = geo.longitude;
        if (geo._geocodeError) {
          setClientFormMessage(
            'Client enregistré sans coordonnées GPS : ' + geo._geocodeError
          );
        }
      }

      if (id) {
        const payload = { name, address, phone, notes, latitude, longitude };
        if (latitude == null) delete payload.latitude;
        if (longitude == null) delete payload.longitude;

        const { error } = await supabase
          .from('clients')
          .update(payload)
          .eq('id', id);
        if (error) throw error;
        setClientFormMessage('Client mis à jour.');
      } else {
        const { error } = await supabase
          .from('clients')
          .insert([{ name, address, phone, notes, latitude, longitude }]);
        if (error) throw error;
        setClientFormMessage('Client ajouté.');
      }

      await loadClients();
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
      fait
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

    const faitRaw =
      intv.fait === true
        ? 'validé'
        : intv.fait === false || intv.fait == null
          ? 'en attente'
          : intv.fait;
    const isDone = intv.status === 'done';
    const isManuallyValidated = validatedInterventions.has(intv.id);
    // Priorité au statut persisté en base : si status = done, on affiche toujours "validé"
    // (même si la vue calcule encore "Pb position"/"Pb temps").
    const fait = isDone ? 'validé' : (isManuallyValidated ? 'validé' : faitRaw);

    const canEdit = !isManuallyValidated && fait === 'en attente';
    const disabledAttr = canEdit ? '' : 'disabled';
    const disabledClass = canEdit ? '' : ' disabled';
    const disabledStyle = canEdit
      ? ''
      : 'style="background-color:#cccccc; color:#666666; cursor:not-allowed;"';

    tr.dataset.id = intv.id;
    tr.dataset.fait = fait;

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
      <td>${fait}</td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-secondary btn-small${disabledClass}"
                  data-action="edit"
                  ${disabledAttr}
                  ${disabledStyle}>Modifier</button>
          <button class="btn btn-secondary btn-small${disabledClass}"
                  data-action="delete"
                  ${disabledAttr}
                  ${disabledStyle}>Supprimer</button>
          <button class="btn btn-primary btn-small"
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

    const fait = row.dataset.fait;

    if (action === 'edit' || action === 'delete') {
      if (fait && fait !== 'en attente') {
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

        const faitCell = row.querySelector('td:nth-child(6)');
        if (faitCell) {
          faitCell.textContent = 'validé';
        }
        row.dataset.fait = 'validé';

        row
          .querySelectorAll('button[data-action="edit"], button[data-action="delete"]')
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
      setDistanceFormMessage('La distance en km est obligatoire.', 'error');
      return;
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

    data.forEach((row) => {
      const tr = document.createElement('tr');

      const monthLabel =
        row.month != null
          ? String(row.month)
          : '';

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
        <td>${monthLabel}</td>
        <td>${row.first_name ?? ''}</td>
        <td>${row.last_name ?? ''}</td>
        <td>${hours}</td>
        <td>${km}</td>
        <td>${missingTrips}</td>
      `;

      employeeMonthSummaryTableBody.appendChild(tr);
    });
  } catch (err) {
    console.error('Erreur loadEmployeeMonthSummary', err);
    employeeMonthSummaryTableBody.innerHTML =
      '<tr><td colspan="6">Erreur lors du chargement du bilan mensuel.</td></tr>';
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
  } catch (err) {
    console.error('Erreur loadClientMonthlyBilan', err);
    clientMonthlyBilanTableBody.innerHTML =
      '<tr><td colspan="4">Erreur lors du chargement du bilan mensuel client.</td></tr>';
    setClientMonthlyBilanMessage(err.message ?? 'Erreur inconnue.', 'error');
  }
}

async function loadMissingDistances() {
  if (!missingDistancesTableBody) return;

  missingDistancesTableBody.innerHTML =
    '<tr><td colspan="4">Chargement…</td></tr>';
  setMissingDistancesMessage('');

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
    if (action !== 'save-missing-distance') return;

    const row = target.closest('tr');
    if (!row) return;

    const clientAId = row.dataset.clientAId;
    const clientBId = row.dataset.clientBId;
    if (!clientAId || !clientBId) return;

    const input = row.querySelector('.missing-distance-input');
    if (!input) return;

    const raw = input.value.trim();
    if (!raw) {
      setMissingDistancesMessage(
        'Merci de saisir une distance en km.',
        'error'
      );
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
let pointagesInterval = null;

function startAutoRefreshInterventions() {
  if (interventionsInterval) clearInterval(interventionsInterval);
  interventionsInterval = setInterval(loadInterventions, 10000);
}

function stopAutoRefreshInterventions() {
  if (interventionsInterval) clearInterval(interventionsInterval);
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
