// API base URL for the Worker. Overwritten at deploy time once the
// Worker URL is known.
window.LSE_API_BASE = localStorage.getItem('lse_api_base')
  || "https://lead-support-engine-api.mwszghdkkf.workers.dev";
