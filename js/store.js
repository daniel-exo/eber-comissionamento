// Camada de armazenamento: Firebase Authentication + Cloud Firestore com cache offline.
// É o único arquivo que conhece o Firebase; a interface (app.js) só usa as funções exportadas aqui.
import {
  initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut,
  connectAuthEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, getDoc, onSnapshot, query, where, serverTimestamp, connectFirestoreEmulator,
} from './vendor/firebase.js';
import { firebaseConfig } from './firebase-config.js';

export const configurado = !!(firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('COLE'));

let auth = null, fs = null;
if (configurado) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // cache persistente: tudo o que foi aberto fica no aparelho e as marcações sem sinal entram numa fila
  fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    // desenvolvimento local contra o emulador do Firebase
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(fs, '127.0.0.1', 8080);
  }
}

/* ---------------- login ---------------- */
export function aoMudarUsuario(cb) {
  if (!auth) { cb(null); return () => {}; }
  return onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, email: u.email } : null));
}
export async function entrar(email, senha) { await signInWithEmailAndPassword(auth, email.trim(), senha); }
export async function redefinirSenha(email) { await sendPasswordResetEmail(auth, email.trim()); }
export async function sair() { await signOut(auth); }

// o usuário só tem acesso se o administrador criou o documento usuarios/<uid> (ver README)
export async function acessoLiberado(uid) {
  try { const s = await getDoc(doc(fs, 'usuarios', uid)); return s.exists() ? true : false; }
  catch (e) { return e && e.code === 'unavailable' ? null : false; }   // null = sem conexão, não dá para saber
}

/* ---------------- checklists ----------------
   Um documento por EQUIPAMENTO CENTRAL (coleção "centrais", ID = <área>.<tag central>, ex. "200.TNQ-2001"),
   com todos os checklists dos equipamentos dele no mapa "ck". Assim, abrir uma área lê poucas dezenas de
   documentos em vez de milhares — o que mantém o app folgado dentro da cota gratuita de leituras.

   centrais/200.TNQ-2001 = {
     area: "200", central: "TNQ-2001", por: <último e-mail>, em: <hora do servidor>,
     ck: { "200:TNQ-2001:AGT-2001~MEC": { checked: { "MEC-AGT-01": true, ... }, por, em }, ... }
   }
   A chave de cada checklist é o local na lista com ":" no lugar de "." + "~" + especialidade.
   A gravação usa merge item a item: pessoas marcando itens diferentes (mesmo offline) não apagam
   a marcação uma da outra; no mesmo item, vale a última que chegar ao banco. */
const chave = (loc, sec) => loc.replace(/\./g, ':') + '~' + sec;
const idLocal = k => { const [l, s] = k.split('~'); return l.replace(/:/g, '.') + '~' + s; };

export function observarArea(area, cb, erro) {
  const q = query(collection(fs, 'centrais'), where('area', '==', area));
  return onSnapshot(q, { includeMetadataChanges: true }, snap => {
    const docs = {};
    let pendentes = 0;
    snap.docs.forEach(d => {
      const ck = (d.data({ serverTimestamps: 'estimate' }).ck) || {};
      for (const k in ck) docs[idLocal(k)] = ck[k];
      if (d.metadata.hasPendingWrites) pendentes++;
    });
    cb(docs, { pendentes, doCache: snap.metadata.fromCache });
  }, e => erro && erro(e));
}

export function marcarItem(area, central, loc, sec, itemId, valor, email) {
  const ref = doc(fs, 'centrais', area + '.' + central);
  // não esperamos a confirmação do servidor: offline, a promessa só resolve quando a conexão voltar
  return setDoc(ref, {
    area, central, por: email, em: serverTimestamp(),
    ck: { [chave(loc, sec)]: { checked: { [itemId]: valor }, por: email, em: serverTimestamp() } },
  }, { merge: true });
}
