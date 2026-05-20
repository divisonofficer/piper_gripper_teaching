import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MobileApp from "./pages/MobilePage";

const isMobile = window.location.pathname.startsWith("/mobile");

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    {isMobile ? <MobileApp /> : <App />}
  </React.StrictMode>
);
