import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  TextInput,
  Button,
  ActivityIndicator,
  View,
  ScrollView,
  TouchableOpacity,
  ImageBackground,
} from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { supabase } from '@/lib/supabaseClient';
import * as Location from 'expo-location';

const PRIMARY_BUTTON_COLOR = '#2196F3';

type Intervention = {
  id: string;
  client_id: string | null;
  date: string | null;
  start_time_planned: string | null;
  end_time_planned: string | null;
  status: string | null;
  fait: string | null;
  saved: boolean | null;
};

type Client = {
  id: string;
  name: string | null;
  address: string | null;
  phone: string | null;
  notes: string | null;
};

type PointageType = 'start' | 'end';

type PointagesMap = Record<
  string,
  {
    start?: string;
    end?: string;
  }
>;

type PrimaryButtonProps = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
};

function PrimaryButton({ title, onPress, disabled }: PrimaryButtonProps) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.primaryButton, disabled && styles.primaryButtonDisabled]}
    >
      <ThemedText style={styles.primaryButtonText}>{title}</ThemedText>
    </TouchableOpacity>
  );
}

export default function TabOneScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loadingLogin, setLoadingLogin] = useState(false);
  const [loadingInterventions, setLoadingInterventions] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [pointageLoadingKey, setPointageLoadingKey] = useState<string | null>(null);
  const [pointageMessage, setPointageMessage] = useState<string | null>(null);
  const [pointagesMap, setPointagesMap] = useState<PointagesMap>({});
  const [clientsMap, setClientsMap] = useState<Record<string, Client>>({});

  useEffect(() => {
    if (!userId) return;

    const refreshInterventions = () => {
      loadInterventions(userId).then((loadedInterventions) => {
        loadClients(loadedInterventions);
      });
    };

    const channel = supabase
      .channel(`employee-interventions-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'interventions',
          filter: `employee_id=eq.${userId}`,
        },
        refreshInterventions
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'interventions' },
        refreshInterventions
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'interventions',
          filter: `employee_id=eq.${userId}`,
        },
        (payload) => {
          const updatedIntervention = payload.new as { saved?: boolean };
          if (updatedIntervention.saved === true) {
            refreshInterventions();
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  async function handleLogin() {
    if (!email || !password) {
      setErrorMessage('Merci de saisir un email et un mot de passe.');
      setSuccessMessage(null);
      return;
    }

    try {
      setLoadingLogin(true);
      setErrorMessage(null);
      setSuccessMessage(null);
      setPointageMessage(null);

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setErrorMessage(error.message);
        setUserId(null);
        setInterventions([]);
        setPointagesMap({});
        setClientsMap({});
      } else if (data?.user) {
        setSuccessMessage('Connexion réussie ✅');
        setUserId(data.user.id);
        await Promise.all([
          loadPointages(data.user.id),
          loadInterventions(data.user.id).then((loadedInterventions) =>
            loadClients(loadedInterventions)
          ),
        ]);
      } else {
        setErrorMessage("Impossible de se connecter (réponse inattendue).");
        setUserId(null);
        setInterventions([]);
        setPointagesMap({});
        setClientsMap({});
      }
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Erreur inconnue lors de la connexion.');
      setUserId(null);
      setInterventions([]);
      setPointagesMap({});
      setClientsMap({});
    } finally {
      setLoadingLogin(false);
    }
  }

  async function handleLogout() {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      // ignore logout errors
    } finally {
      setUserId(null);
      setInterventions([]);
      setPointagesMap({});
      setClientsMap({});
      setPointageMessage(null);
      setSuccessMessage(null);
      setErrorMessage(null);
      setPassword('');
    }
  }

  
function getTwoWeekRangeFromCurrentWeek() {
  const today = new Date();
  const day = today.getDay(); // 0 = dimanche, 1 = lundi, ...

  // La semaine courante reste affichee jusqu'au dimanche soir.
  const startOfWeek = new Date(today);
  const diffToMonday = (day + 6) % 7; // 0 si lundi, 6 si dimanche
  startOfWeek.setDate(today.getDate() - diffToMonday);
  startOfWeek.setHours(0, 0, 0, 0);

  const toDate = new Date(startOfWeek);
  toDate.setDate(startOfWeek.getDate() + 14);

  const formatLocalDate = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const dateOfMonth = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${dateOfMonth}`;
  };

  const from = formatLocalDate(startOfWeek);
  const to = formatLocalDate(toDate);

  return { from, to };
}

async function loadInterventions(employeeId: string) {
    try {
      setLoadingInterventions(true);
      const { data, error } = await supabase
        .from('interventions_progress_admin')
        .select(
          'id, client_id, date, start_time_planned, end_time_planned, status, fait, saved'
        )
        .eq('employee_id', employeeId)
        .gte('date', getTwoWeekRangeFromCurrentWeek().from)
        .lt('date', getTwoWeekRangeFromCurrentWeek().to)
        .order('date', { ascending: true })
        .order('start_time_planned', { ascending: true });

      if (error) {
        setErrorMessage(error.message);
        setInterventions([]);
        return;
      }

      const loadedInterventions = (data ?? []) as Intervention[];
      setInterventions(loadedInterventions);
      return loadedInterventions;
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Erreur lors du chargement des interventions.');
      setInterventions([]);
      return [];
    } finally {
      setLoadingInterventions(false);
    }
  }

  async function loadPointages(employeeId: string) {
    try {
      const { data, error } = await supabase
        .from('pointages')
        .select('id, intervention_id, type, timestamp')
        .eq('employee_id', employeeId)
        .order('timestamp', { ascending: true });

      if (error) {
        setErrorMessage(error.message);
        setPointagesMap({});
        return;
      }

      const map: PointagesMap = {};
      (data ?? []).forEach((row: any) => {
        const key = row.intervention_id as string;
        const type = row.type as PointageType;
        const ts = row.timestamp as string;

        if (!map[key]) {
          map[key] = {};
        }
        if (type === 'start') {
          map[key].start = ts;
        } else if (type === 'end') {
          map[key].end = ts;
        }
      });

      setPointagesMap(map);
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Erreur lors du chargement des pointages.');
      setPointagesMap({});
    }
  }

  async function loadClients(loadedInterventions = interventions) {
    const clientIds = Array.from(
      new Set(
        loadedInterventions
          .map((intervention) => intervention.client_id)
          .filter((id): id is string => !!id)
      )
    );

    if (clientIds.length === 0) {
      setClientsMap({});
      return;
    }

    try {
      const { data, error } = await supabase
        .from('clients')
        .select('id, name, address, phone, notes')
        .in('id', clientIds);

      if (error) {
        setErrorMessage(error.message);
        setClientsMap({});
        return;
      }

      const map: Record<string, Client> = {};
      (data ?? []).forEach((row: any) => {
        map[row.id as string] = row as Client;
      });

      setClientsMap(map);
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Erreur lors du chargement des clients.');
      setClientsMap({});
    }
  }

  async function handlePointage(interventionId: string, type: PointageType) {
    if (!userId) {
      setErrorMessage('Vous devez être connecté pour pointer.');
      return;
    }

    // Une seule intervention en cours à la fois : on bloque un deuxième "Début"
    if (type === 'start') {
      const hasOtherOngoing = Object.entries(pointagesMap).some(
        ([id, p]) =>
          id !== interventionId &&
          // une intervention "validee" (saved=true) ne doit pas bloquer
          nonValidatedInterventionIds.has(id) &&
          p &&
          p.start &&
          !p.end
      );
      if (hasOtherOngoing) {
        setErrorMessage(
          "Vous avez déjà une intervention en cours. Terminez-la avant d'en commencer une autre."
        );
        return;
      }
    }

    try {
      setErrorMessage(null);
      setPointageMessage(null);
      const loadingKey = `${type}-${interventionId}`;
      setPointageLoadingKey(loadingKey);

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMessage('Permission de localisation refusée. Impossible de pointer.');
        setPointageLoadingKey(null);
        return;
      }

      const position = await Location.getCurrentPositionAsync({});
      const { latitude, longitude, accuracy } = position.coords;

      const { data, error } = await supabase.rpc('create_pointage', {
        p_intervention_id: interventionId,
        p_type: type,
        p_latitude: latitude,
        p_longitude: longitude,
        p_accuracy: accuracy ?? null,
      });

      if (error) {
        setErrorMessage(error.message);
        setPointageMessage(null);
      } else {
        const label = type === 'start' ? 'début' : 'fin';
        setPointageMessage(`Pointage ${label} enregistré ✅`);

        if (data) {
          const inserted = data as any;
          const key = inserted.intervention_id as string;
          const insertedType = inserted.type as PointageType;
          const ts = inserted.timestamp as string;

          setPointagesMap((prev) => {
            const next = { ...prev };
            if (!next[key]) next[key] = {};
            if (insertedType === 'start') {
              next[key].start = ts;
            } else if (insertedType === 'end') {
              next[key].end = ts;
            }
            return next;
          });
        }

        await loadPointages(userId);
        if (type === 'end') {
          const loadedInterventions = await loadInterventions(userId);
          await loadClients(loadedInterventions);
        }
      }
    } catch (err: any) {
      setErrorMessage(err?.message ?? "Erreur lors de l’enregistrement du pointage.");
      setPointageMessage(null);
    } finally {
      setPointageLoadingKey(null);
    }
  }

  function formatDate(date: string | null) {
    if (!date) return '';
    try {
      const [y, m, d] = date.split('-');
      if (!y || !m || !d) return date ?? '';
      return `${d}/${m}/${y}`;
    } catch (err) {
      return date ?? '';
    }
  }

  function formatDateWithDay(date: string | null) {
    if (!date) return '';
    try {
      const [y, m, d] = date.split('-');
      if (!y || !m || !d) return formatDate(date);
      const jsDate = new Date(Number(y), Number(m) - 1, Number(d));
      const days = [
        'dimanche',
        'lundi',
        'mardi',
        'mercredi',
        'jeudi',
        'vendredi',
        'samedi',
      ];
      const dayName = days[jsDate.getDay()] ?? '';
      const base = formatDate(date);
      return dayName ? `${dayName} ${base}` : base;
    } catch (err) {
      return formatDate(date);
    }
  }

  function formatTime(time: string | null) {
    if (!time) return '';
    return time.slice(0, 5);
  }

  function getCompletedStatusLabel(value: string | null) {
    const status = (value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    if (status === 'fait') return 'fait';
    if (status.includes('position') && status.includes('temps')) {
      return 'pb position+temps';
    }
    if (status.includes('position')) return 'pb position';
    if (status.includes('temps')) return 'pb temps';
    return null;
  }

  function formatDateTime(ts?: string) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
      const day = pad(d.getDate());
      const month = pad(d.getMonth() + 1);
      const year = d.getFullYear();
      const hours = pad(d.getHours());
      const minutes = pad(d.getMinutes());
      return `${day}/${month}/${year} ${hours}:${minutes}`;
    } catch (err) {
      return ts ?? '';
    }
  }

  // Une seule intervention peut etre en cours a la fois.
  // IMPORTANT: si l'admin "valide" une intervention (saved=true / status done),
  // elle ne doit jamais bloquer les suivantes, meme si un pointage "start" existe
  // sans "end" (cas incoherent).
  // On ne considere donc "en cours" que les interventions presentes dans la liste
  // et non validees.
  const nonValidatedInterventionIds = new Set(
    interventions
      .filter((i) => !(i as any)?.saved)
      .map((i) => i.id)
  );

  const ongoingInterventionId =
    Object.entries(pointagesMap).find(
      ([id, p]) =>
        nonValidatedInterventionIds.has(id) && p && p.start && !p.end
    )?.[0] ?? null;

  const interventionsWithHeaders: {
    type: 'header' | 'item';
    key: string;
    date?: string | null;
    intervention?: Intervention;
  }[] = [];

  {
    let lastDate: string | null = null;
    for (const intervention of interventions) {
      const currentDate = intervention.date;
      if (currentDate && currentDate !== lastDate) {
        interventionsWithHeaders.push({
          type: 'header',
          key: `header-${currentDate}`,
          date: currentDate,
        });
        lastDate = currentDate;
      }
      interventionsWithHeaders.push({
        type: 'item',
        key: `item-${intervention.id}-${intervention.date}`,
        intervention,
      });
    }
  }

  return (
    <ImageBackground
      source={require('../../assets/images/bg_light.jpg')}
      style={styles.bgImage}
      resizeMode="cover"
    >
      <ThemedView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <ThemedText type="title" style={styles.title}>
            AVSapp
          </ThemedText>

          {!userId && (
            <>
          <ThemedText style={styles.label}>Email</ThemedText>
          <TextInput
            style={styles.input}
            placeholder="email de l'employé"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <ThemedText style={styles.label}>Mot de passe</ThemedText>
          <TextInput
            style={styles.input}
            placeholder="mot de passe"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
            </>
          )}

          <View style={styles.buttonRow}>
            {!userId && (
              <View style={styles.buttonContainer}>
                {loadingLogin ? (
                  <ActivityIndicator />
                ) : (
                  <Button title="Se connecter" onPress={handleLogin} />
                )}
              </View>
            )}

            {userId && (
              <View style={styles.buttonContainer}>
                <Button title="Se déconnecter" onPress={handleLogout} />
              </View>
            )}
          </View>

          {successMessage && (
            <ThemedText style={[styles.message, styles.success]}>
              {successMessage}
            </ThemedText>
          )}

          {errorMessage && (
            <ThemedText style={[styles.message, styles.error]}>
              {errorMessage}
            </ThemedText>
          )}

            <ThemedText style={styles.hint}>
            Les interventions apparaissent ci-dessous. Une seule intervention peut être
            en cours à la fois.
          </ThemedText>

          {userId && (
            <View style={styles.interventionsSection}>
              <ThemedText type="subtitle" style={styles.sectionTitle}>
                Mes interventions
              </ThemedText>

              {loadingInterventions && <ActivityIndicator />}

              {!loadingInterventions && interventions.length === 0 && (
                <ThemedText>Aucune intervention.</ThemedText>
              )}

              {!loadingInterventions &&
                interventionsWithHeaders.map((entry) => {
                  if (entry.type === 'header') {
                    return (
                      <ThemedText key={entry.key} style={styles.dayHeader}>
                        {formatDateWithDay(entry.date ?? null)}
                      </ThemedText>
                    );
                  }

                  const intervention = entry.intervention!;
                  const pointages = pointagesMap[intervention.id] ?? {};
                  const client = intervention.client_id
                    ? clientsMap[intervention.client_id]
                    : undefined;
                  const isValidatedByAdmin = intervention.saved === true;
                  const completedStatus = pointages.end
                    ? getCompletedStatusLabel(intervention.fait)
                    : null;

                  return (
                    <ThemedView
                      key={entry.key}
                      style={styles.interventionCard}
                    >
                      {client && (
                        <View style={styles.clientBlock}>
                          <ThemedText style={styles.clientName}>
                            Client : {client.name || '—'}
                          </ThemedText>
                          <ThemedText style={styles.clientLine}>
                            Adresse : {client.address || '—'}
                          </ThemedText>
                          <ThemedText style={styles.clientLine}>
                            Téléphone : {client.phone || '—'}
                          </ThemedText>
                          <ThemedText style={styles.clientLine}>
                            Notes : {client.notes || '—'}
                          </ThemedText>
                        </View>
                      )}

                      <ThemedText style={styles.interventionDate}>
                        {formatDate(intervention.date)}
                      </ThemedText>
                      <ThemedText style={styles.interventionTime}>
                        {formatTime(intervention.start_time_planned)} -{' '}
                        {formatTime(intervention.end_time_planned)}
                      </ThemedText>

                      <View style={styles.pointageInfo}>
                        <ThemedText style={styles.pointageInfoText}>
                          Dernier début :{' '}
                          {formatDateTime(pointages.start ?? undefined) || '—'}
                        </ThemedText>
                        <ThemedText style={styles.pointageInfoText}>
                          Dernière fin :{' '}
                          {formatDateTime(pointages.end ?? undefined) || '—'}
                        </ThemedText>
                      </View>

                      <View style={styles.pointageButtonsRow}>
                        {!isValidatedByAdmin &&
                          !pointages.start &&
                          !pointages.end &&
                          !ongoingInterventionId && (
                            <PrimaryButton
                              title="Début"
                              onPress={() =>
                                handlePointage(intervention.id, 'start')
                              }
                              disabled={!!pointageLoadingKey}
                            />
                          )}

                        {!isValidatedByAdmin &&
                          pointages.start &&
                          !pointages.end &&
                          ongoingInterventionId === intervention.id && (
                            <PrimaryButton
                              title="Fin"
                              onPress={() =>
                                handlePointage(intervention.id, 'end')
                              }
                              disabled={!!pointageLoadingKey}
                            />
                          )}

                        {isValidatedByAdmin ? (
                          <ThemedText style={styles.finiText}>
                            validé
                          </ThemedText>
                        ) : completedStatus ? (
                          <ThemedText style={styles.finiText}>
                            {completedStatus}
                          </ThemedText>
                        ) : null}
                      </View>

                      {pointageLoadingKey &&
                        pointageLoadingKey.endsWith(intervention.id) && (
                          <View style={styles.pointageLoadingRow}>
                            <ActivityIndicator />
                            <ThemedText style={styles.pointageLoadingText}>
                              Enregistrement du pointage...
                            </ThemedText>
                          </View>
                        )}
                    </ThemedView>
                  );
                })}
            </View>
          )}
        </ScrollView>
      </ThemedView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  bgImage: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  scrollContent: {
    flexGrow: 1,
    padding: 16,
    gap: 12,
  },
  title: {
    marginBottom: 12,
    textAlign: 'center',
  },
  label: {
    fontSize: 14,
    marginTop: 8,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    backgroundColor: 'white',
  },
  buttonRow: {
    flexDirection: 'row',
    marginTop: 16,
    justifyContent: 'space-between',
    gap: 8,
  },
  buttonContainer: {
    flex: 1,
    alignItems: 'center',
  },
  message: {
    marginTop: 12,
    fontSize: 14,
  },
  success: {
    color: 'green',
  },
  error: {
    color: 'red',
  },
  hint: {
    marginTop: 16,
    fontSize: 12,
    textAlign: 'center',
  },
  interventionsSection: {
    marginTop: 24,
    gap: 12,
  },
  sectionTitle: {
    marginBottom: 8,
  },
  dayHeader: {
    marginTop: 12,
    marginBottom: 4,
    fontWeight: 'bold',
  },
  interventionCard: {
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: 'rgba(249, 249, 249, 0.9)',
    gap: 8,
    marginBottom: 12,
  },
  clientBlock: {
    marginBottom: 8,
    gap: 2,
  },
  clientName: {
    fontWeight: 'bold',
  },
  clientLine: {
    fontSize: 12,
  },
  interventionDate: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  interventionTime: {
    fontSize: 14,
  },
  pointageInfo: {
    marginTop: 8,
    gap: 2,
  },
  pointageInfoText: {
    fontSize: 12,
  },
  pointageButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    gap: 8,
  },
  pointageLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 8,
  },
  pointageLoadingText: {
    fontSize: 12,
  },
  finiText: {
    marginTop: 4,
    fontSize: 14,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  primaryButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: PRIMARY_BUTTON_COLOR,
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
});
