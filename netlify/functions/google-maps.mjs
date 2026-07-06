const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });

const getApiKey = () => {
  const key = Netlify.env.get('GOOGLE_MAPS_API_KEY');
  if (!key) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }
  return key;
};

const parseLatLng = (value, label) => {
  const latitude = Number(value?.latitude);
  const longitude = Number(value?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`${label} GPS invalide`);
  }
  return `${latitude},${longitude}`;
};

async function handleGeocode(body, apiKey) {
  const address = String(body.address || '').trim();
  if (!address) {
    return json({ error: 'Adresse obligatoire' }, 400);
  }

  const params = new URLSearchParams({
    address,
    region: 're',
    language: 'fr',
    key: apiKey,
  });
  const response = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?${params}`
  );
  const data = await response.json();

  if (!response.ok || data.status !== 'OK' || !data.results?.length) {
    return json(
      {
        error:
          data.error_message ||
          `Geocoding impossible (${data.status || response.status})`,
        status: data.status || String(response.status),
      },
      502
    );
  }

  const result = data.results[0];
  const location = result.geometry?.location;
  const latitude = Number(location?.lat);
  const longitude = Number(location?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return json({ error: 'Coordonnees Google invalides' }, 502);
  }

  return json({
    latitude,
    longitude,
    formattedAddress: result.formatted_address || null,
    placeId: result.place_id || null,
    locationType: result.geometry?.location_type || null,
    status: data.status,
  });
}

async function handleDistance(body, apiKey) {
  const origin = parseLatLng(body.origin, 'Origine');
  const destination = parseLatLng(body.destination, 'Destination');

  const params = new URLSearchParams({
    origins: origin,
    destinations: destination,
    mode: 'driving',
    units: 'metric',
    language: 'fr',
    key: apiKey,
  });
  const response = await fetch(
    `https://maps.googleapis.com/maps/api/distancematrix/json?${params}`
  );
  const data = await response.json();

  const element = data.rows?.[0]?.elements?.[0];
  if (
    !response.ok ||
    data.status !== 'OK' ||
    !element ||
    element.status !== 'OK'
  ) {
    return json(
      {
        error:
          data.error_message ||
          `Distance impossible (${element?.status || data.status || response.status})`,
        status: element?.status || data.status || String(response.status),
      },
      502
    );
  }

  const distanceMeters = Number(element.distance?.value);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return json({ error: 'Distance Google invalide' }, 502);
  }

  return json({
    distanceMeters,
    distanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
    durationSeconds: element.duration?.value ?? null,
    originAddress: data.origin_addresses?.[0] || null,
    destinationAddress: data.destination_addresses?.[0] || null,
    status: element.status,
  });
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const apiKey = getApiKey();
    const body = await req.json();
    if (body.action === 'geocode') {
      return await handleGeocode(body, apiKey);
    }
    if (body.action === 'distance') {
      return await handleDistance(body, apiKey);
    }
    return json({ error: 'Action inconnue' }, 400);
  } catch (error) {
    return json({ error: error?.message || 'Erreur Google Maps' }, 500);
  }
};

export const config = {
  path: '/api/google-maps',
  method: ['POST'],
};
