const config = {
  port: Number(process.env.PORT || 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  browserTimeoutMs: Number(process.env.BROWSER_TIMEOUT_MS || 45000),
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
  maxImages: Number(process.env.MAX_IMAGES || 50)
};

module.exports = config;
