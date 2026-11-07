// Маршрутизация по адресу после «#»: #/, #/play/<id>, #/edit/<id>.
import { useSyncExternalStore } from 'react';

const read = () => location.hash.replace(/^#/, '') || '/';

const subscribe = (callback: () => void) => {
  addEventListener('hashchange', callback);
  return () => removeEventListener('hashchange', callback);
};

export const useRoute = () => useSyncExternalStore(subscribe, read);

export const navigate = (path: string) => {
  location.hash = path;
};
