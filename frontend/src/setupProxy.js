const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = function (app) {
  const TARGET = "http://localhost:5002";

  // Socket.IO (WebSocket 포함)
  app.use(
    "/socket.io",
    createProxyMiddleware({
      target: TARGET,
      changeOrigin: true,
      ws: true,
    })
  );

  // REST API
  app.use(
    "/api",
    createProxyMiddleware({
      target: TARGET,
      changeOrigin: true,
    })
  );

  // MJPEG camera stream
  app.use(
    "/stream",
    createProxyMiddleware({
      target: TARGET,
      changeOrigin: true,
    })
  );
};
