// @ts-check
export function isAllowedLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    return ['http:', 'https:'].includes(protocol)
      && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

export function localCorsOptions(origin, callback) {
  if (isAllowedLocalOrigin(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error('Not allowed by CORS'));
}

export function getListenHost() {
  return process.env.HOST || '127.0.0.1';
}
