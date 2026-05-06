import { useEffect } from 'react';

// Bind Escape to a close handler while `isOpen` is true. Used by modals so
// every dismissable surface behaves consistently with keyboard input.
export const useEscClose = (isOpen: boolean, onClose: () => void) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);
};
