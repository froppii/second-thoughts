// Where the game database lives.
// On your laptop or local Wi-Fi: SpacetimeDB running on the same machine (spacetime start).
// Anywhere else (Vercel, a tunnel): SpacetimeDB maincloud. Change CLOUD_DB if you publish under another name.
(function () {
  var CLOUD_DB = 'second-thoughts-froppii';
  var h = location.hostname;
  var local = h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  window.STDB = local
    ? { uri: 'ws://' + h + ':3000', db: 'second-thoughts' }
    : { uri: 'wss://maincloud.spacetimedb.com', db: CLOUD_DB };
})();