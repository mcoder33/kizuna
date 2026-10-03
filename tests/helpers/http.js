import request from 'supertest';

// Supertest defaults to an IPv4 URL even for an IPv6-only/wildcard listener.
// macOS may allocate a wildcard IPv6 port already used by an IPv4 service.
// Follow the actual listener family, keeping the original logical Host so
// Origin, redirects and application security behave exactly as before.
const serverAddress = request.Test.prototype.serverAddress;
request.Test.prototype.serverAddress = function(server, path) {
  const logicalUrl = serverAddress.call(this, server, path);
  if (server.address()?.family !== 'IPv6') return logicalUrl;
  this.set('Host', new URL(logicalUrl).host);
  return logicalUrl.replace('://127.0.0.1:', '://[::1]:');
};

export default request;
