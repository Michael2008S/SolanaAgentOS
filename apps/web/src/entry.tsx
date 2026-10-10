/** @jsxImportSource ./i18n */
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './main';
import { Providers } from './providers';

// Mount once. App is a React refresh boundary, so edits to task progress do not
// reload the business page and discard its pending review or in-memory Session.
createRoot(document.getElementById('root')!).render(<React.StrictMode><Providers><App /></Providers></React.StrictMode>);
