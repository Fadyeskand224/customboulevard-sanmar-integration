'use strict';

/**
 * Live inventory lookup via SanMar's PromoStandards Inventory Service V2.0.0
 * (SOAP/XML). Used for on-demand backfill of a small number of styles —
 * for bulk/scheduled inventory sync, prefer sanmar_dip.txt (see
 * inventory-sync.js) per SanMar's own stated best practices.
 *
 * partId in the response is SanMar's unique_key (INVENTORY_KEY + SIZE_INDEX
 * combined) — the exact same value used as the Shopify Variant SKU
 * throughout this project (see mapper.js), so results join directly by SKU.
 */

const axios = require('axios');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ENDPOINT = 'https://ws.sanmar.com:8080/promostandards/InventoryServiceBindingV2final';

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
});

function buildRequest(style) {
  const username = process.env.SANMAR_SOAP_USERNAME;
  const password = process.env.SANMAR_SOAP_PASSWORD;
  if (!username || !password) {
    throw new Error('Missing SANMAR_SOAP_USERNAME or SANMAR_SOAP_PASSWORD in .env');
  }
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
xmlns:ns="http://www.promostandards.org/WSDL/Inventory/2.0.0/"
xmlns:shar="http://www.promostandards.org/WSDL/Inventory/2.0.0/SharedObjects/">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:GetInventoryLevelsRequest>
      <shar:wsVersion>2.0.0</shar:wsVersion>
      <shar:id>${username}</shar:id>
      <shar:password>${password}</shar:password>
      <shar:productId>${style}</shar:productId>
    </ns:GetInventoryLevelsRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Returns a Map: partId (= SanMar unique_key = Shopify variant SKU) ->
 * { quantityAvailable, partColor, labelSize, warehouses: [{id,name,qty}] }
 * for a single style (SanMar productId).
 */
async function getInventoryForStyle(style) {
  const xml = buildRequest(style);
  const res = await axios.post(ENDPOINT, xml, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
    timeout: 30000,
  });

  const parsed = parser.parse(res.data);
  const envelope = parsed.Envelope || parsed['soap:Envelope'];
  const body = envelope.Body;
  const response = body.GetInventoryLevelsResponse;

  if (!response) {
    const fault = body.Fault;
    throw new Error(fault ? `SOAP fault: ${JSON.stringify(fault)}` : `Unexpected response shape: ${JSON.stringify(body)}`);
  }

  const inventory = response.Inventory;
  const parts = asArray(inventory?.PartInventoryArray?.PartInventory);
  const result = new Map();

  for (const part of parts) {
    const warehouses = asArray(part.InventoryLocationArray?.InventoryLocation).map((loc) => ({
      id: loc.inventoryLocationId,
      name: loc.inventoryLocationName,
      qty: Number(loc.inventoryLocationQuantity?.Quantity?.value || 0),
    }));

    result.set(String(part.partId), {
      quantityAvailable: Number(part.quantityAvailable?.Quantity?.value || 0),
      partColor: part.partColor,
      labelSize: part.labelSize,
      warehouses,
    });
  }

  return result;
}

/**
 * Fetches inventory for multiple styles sequentially (small, polite pacing —
 * this is meant for on-demand backfill of a handful of styles, not bulk).
 * Returns a single Map merged across all styles, keyed by partId.
 */
async function getInventoryForStyles(styles) {
  const merged = new Map();
  for (const style of styles) {
    const styleInventory = await getInventoryForStyle(style);
    for (const [partId, data] of styleInventory) merged.set(partId, data);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return merged;
}

module.exports = { getInventoryForStyle, getInventoryForStyles };
