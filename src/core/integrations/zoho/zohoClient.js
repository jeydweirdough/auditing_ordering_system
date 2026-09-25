/**
 * ⚠️ SUPERSEDED by LiveZohoAdapter.js (not currently imported anywhere, so
 * this file changes nothing by staying). LiveZohoAdapter.js implements the
 * real ZohoAdapter contract, talks to Zoho's actual Books/Inventory REST
 * API (or, in http-mock mode, the local mock-server/), and has the
 * organization_id allowlist safety check this class lacks. Prefer that.
 */
class ZohoClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    async syncOrder(order) {
        // Implement real Zoho CRM sync logic here
        return Promise.resolve({ success: true, ref: 'ZOHO-REAL-ID' });
    }
}
module.exports = ZohoClient;
