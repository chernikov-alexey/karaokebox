import { ConfirmHost, Toasts } from './components/ui';
import { Editor } from './pages/Editor';
import { Library } from './pages/Library';
import { Play } from './pages/Play';
import { useRoute } from './router';

export function App() {
  const route = useRoute();
  const [, page, id] = route.split('/');
  return (
    <>
      {page === 'play' && id ? <Play key={id} id={id} /> : page === 'edit' && id ? <Editor key={id} id={id} /> : <Library />}
      <Toasts />
      <ConfirmHost />
    </>
  );
}
