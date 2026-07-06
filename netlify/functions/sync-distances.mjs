const SUPABASE_URL = 'https://irdccxgbgkzxdjfskbdx.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_13kjiGwaJdMfnOdTMOviAw_QXcIl3q4';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });

const getGoogleApiKey = () => {
  const key = Netlify.env.get('GOOGLE_MAPS_API_KEY');
  if (!key) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }
  return key;
};

const getSupabaseAuth = (req) => {
  const authorization = req.headers.get('authorization') || '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  return {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    authorization,
  };
};

const supabaseRequest = async (path, auth, options = {}) => {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: auth.apikey,
      authorization: auth.authorization,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      data?.message ||
      data?.hint ||
      data?.details ||
      `Supabase REST error ${response.status}`;
    throw new Error(message);
  }

  return data;
};

const parseCoordinate = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const hasCoordinates = (client) =>
  parseCoordinate(client?.latitude) != null &&
  parseCoordinate(client?.longitude) != null;

const geocodeClient = async (client, auth, googleApiKey) => {
  const address = String(client.address || '').trim();
  if (!address) {
    throw new Error(`Adresse manquante pour ${client.name || client.id}`);
  }

  const params = new URLSearchParams({
    address,
    region: 're',
    language: 'fr',
    key: googleApiKey,
  });

  const response = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?${params}`
  );
  const data = await response.json();
  const result = data.results?.[0];
  const location = result?.geometry?.location;
  const latitude = parseCoordinate(location?.lat);
  const longitude = parseCoordinate(location?.lng);

  if (!response.ok || data.status !== 'OK' || latitude == null || longitude == null) {
    throw new Error(
      data.error_message ||
        `Geocodage impossible pour ${client.name || client.id} (${data.status || response.status})`
    );
  }

  await supabaseRequest(`/rest/v1/clients?id=eq.${client.id}`, auth, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      latitude,
      longitude,
      geocoded_at: new Date().toISOString(),
      geocode_status: 'ok',
    }),
  });

  return {
    ...client,
    latitude,
    longitude,
  };
};

const googleDistanceKm = async (clientA, clientB, googleApiKey) => {
  const origin = `${parseCoordinate(clientA.latitude)},${parseCoordinate(clientA.longitude)}`;
  const destination = `${parseCoordinate(clientB.latitude)},${parseCoordinate(clientB.longitude)}`;

  const params = new URLSearchParams({
    origins: origin,
    destinations: destination,
    mode: 'driving',
    units: 'metric',
    language: 'fr',
    key: googleApiKey,
  });

  const response = await fetch(
    `https://maps.googleapis.com/maps/api/distancematrix/json?${params}`
  );
  const data = await response.json();
  const element = data.rows?.[0]?.elements?.[0];
  const distanceMeters = Number(element?.distance?.value);

  if (
    !response.ok ||
    data.status !== 'OK' ||
    element?.status !== 'OK' ||
    !Number.isFinite(distanceMeters) ||
    distanceMeters <= 0
  ) {
    throw new Error(
      data.error_message ||
        `Distance impossible (${element?.status || data.status || response.status})`
    );
  }

  return Math.round((distanceMeters / 1000) * 100) / 100;
};

const sortPair = (clientAId, clientBId) =>
  clientAId > clientBId ? [clientBId, clientAId] : [clientAId, clientBId];

async function syncMissingDistances(req) {
  const auth = getSupabaseAuth(req);
  if (!auth) {
    return json({ error: 'Session administrateur obligatoire' }, 401);
  }

  const googleApiKey = getGoogleApiKey();
  const body = await req.json().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 100);

  const missingRows =
    (await supabaseRequest(
      `/rest/v1/missing_client_distances?select=client_a_id,client_a_name,client_b_id,client_b_name&order=client_a_name.asc&order=client_b_name.asc&limit=${limit}`,
      auth
    )) || [];

  if (missingRows.length === 0) {
    return json({ checked: 0, inserted: 0, skipped: 0, errors: [] });
  }

  const ids = [
    ...new Set(
      missingRows.flatMap((row) => [row.client_a_id, row.client_b_id]).filter(Boolean)
    ),
  ];
  const clients =
    (await supabaseRequest(
      `/rest/v1/clients?select=id,name,address,latitude,longitude&id=in.(${ids.join(',')})`,
      auth
    )) || [];
  const clientsById = new Map(clients.map((client) => [client.id, client]));

  const rowsToSave = [];
  const errors = [];
  let skipped = 0;

  for (const row of missingRows) {
    try {
      let clientA = clientsById.get(row.client_a_id);
      let clientB = clientsById.get(row.client_b_id);

      if (!clientA || !clientB) {
        skipped += 1;
        errors.push({
          client_a_id: row.client_a_id,
          client_b_id: row.client_b_id,
          message: 'Client introuvable',
        });
        continue;
      }

      if (!hasCoordinates(clientA)) {
        clientA = await geocodeClient(clientA, auth, googleApiKey);
        clientsById.set(clientA.id, clientA);
      }
      if (!hasCoordinates(clientB)) {
        clientB = await geocodeClient(clientB, auth, googleApiKey);
        clientsById.set(clientB.id, clientB);
      }

      const distanceKm = await googleDistanceKm(clientA, clientB, googleApiKey);
      const [client_a_id, client_b_id] = sortPair(row.client_a_id, row.client_b_id);

      rowsToSave.push({
        client_a_id,
        client_b_id,
        distance_km: distanceKm,
        comment: 'Distance routiere Google Maps automatique',
      });
    } catch (error) {
      skipped += 1;
      errors.push({
        client_a_id: row.client_a_id,
        client_b_id: row.client_b_id,
        message: error?.message || 'Erreur inconnue',
      });
    }
  }

  if (rowsToSave.length > 0) {
    await supabaseRequest(
      '/rest/v1/client_distances?on_conflict=client_a_id,client_b_id',
      auth,
      {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rowsToSave),
      }
    );
  }

  return json({
    checked: missingRows.length,
    inserted: rowsToSave.length,
    skipped,
    errors,
  });
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    return await syncMissingDistances(req);
  } catch (error) {
    return json({ error: error?.message || 'Synchronisation impossible' }, 500);
  }
};

export const config = {
  path: '/api/sync-distances',
  method: ['POST'],
};
