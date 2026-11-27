import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './theme.css';
import './open-layout.css';
import './pwa';
import { restoreAccessRoute } from './lib/accessLogin';

restoreAccessRoute();

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
