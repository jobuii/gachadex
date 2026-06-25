import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Landing } from './components/Landing';
import { Exchange } from './pages/Exchange';
import { Docs } from './pages/Docs';
import { useRealtime } from './store/realtime';
import { useChat } from './store/chat';
import * as api from './lib/api.js';

api.capturePendingReferral(); // stash any ?ref=CODE before the URL changes

function App() {
  const startRealtime = useRealtime((s) => s.start);
  const startChat = useChat((s) => s.start);
  // Start the live stores once at the router root, so both the landing (chat) and the exchange have them.
  useEffect(() => {
    startRealtime();
    startChat();
  }, [startRealtime, startChat]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/exchange" element={<Exchange />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
