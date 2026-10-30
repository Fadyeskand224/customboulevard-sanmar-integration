'use strict';

const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const API_BASE = 'https://api.zakeke.com';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const SAFETY_MARGIN_MS = 60 * 1000;
  if (cachedToken && Date.now() < cachedTokenExpiresAt - SAFETY_MARGIN_MS) {
    return cachedToken;
  }

  const clientId = process.env.ZAKEKE_CLIENT_ID;
  const clientSecret = process.env.ZAKEKE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing ZAKEKE_CLIENT_ID or ZAKEKE_CLIENT_SECRET in .env');
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await axios.post(
    `${API_BASE}/token`,
    new URLSearchParams({ grant_type: 'client_credentials', access_type: 'S2S' }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` }, timeout: 20000 }
  );

  cachedToken = res.data.access_token;
  cachedTokenExpiresAt = Date.now() + res.data.expires_in * 1000;
  return cachedToken;
}

async function getClient() {
  const token = await getToken();
  return axios.create({
    baseURL: API_BASE,
    timeout: 45000,
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Full product catalog as currently connected/configured in Zakeke (read-only). */
async function getProducts(client) {
  const res = await client.get('/v2/products');
  return res.data;
}

/** Submits a CSV-import zip (Products.csv/Sides.csv/Areas.csv). Returns { TaskID, LastError }. */
async function submitCsvImport(client, zipBuffer) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('data', zipBuffer, { filename: 'import.zip', contentType: 'application/zip' });

  const res = await client.post('/v2/csv/import', form, {
    headers: { ...form.getHeaders(), Accept: 'application/json' },
  });
  return res.data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls importingresult until Zakeke has processed the task (200) or gives up after maxAttempts. */
async function pollCsvImportResult(client, taskId, { maxAttempts = 180, intervalMs = 5000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await client.get(`/v2/csv/importingresult/${taskId}`, { validateStatus: () => true });
    if (res.status === 200) return res.data;
    const stillProcessing = res.status === 204 || (res.data && /in process/i.test(res.data.message || ''));
    if (!stillProcessing) {
      throw new Error(`Unexpected status polling import result: ${res.status} ${JSON.stringify(res.data)}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for CSV import task ${taskId} to finish`);
}

module.exports = { getToken, getClient, getProducts, submitCsvImport, pollCsvImportResult, sleep };
