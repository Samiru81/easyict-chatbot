import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
  useDeviceLanguage
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const config = window.APP_CONFIG || {};
const firebaseConfig = config.FIREBASE_CONFIG || {};
const requiredConfig = ["apiKey", "authDomain", "projectId", "appId"];
const isConfigured = requiredConfig.every((key) => {
  const value = String(firebaseConfig[key] || "");
  return value && !/YOUR_|PASTE_|PROJECT_ID/i.test(value);
});

const elements = {
  overlay: document.getElementById("authOverlay"),
  message: document.getElementById("authMessage"),
  warning: document.getElementById("authConfigWarning"),
  buttons: Array.from(document.querySelectorAll("[data-auth-provider]")),
  openButton: document.getElementById("openAuth"),
  userMenu: document.getElementById("userMenu"),
  userAvatar: document.getElementById("userAvatar"),
  userName: document.getElementById("userName"),
  signOutButton: document.getElementById("signOutButton")
};

let auth = null;
let currentUser = null;
let authResolved = false;
const subscribers = new Set();
let resolveReady;
const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

initialize();

async function initialize() {
  bindUi();

  if (!isConfigured) {
    elements.warning.hidden = false;
    setMessage("Firebase configuration එක site/config.js ගොනුවට එක් කරන්න.", true);
    setProviderButtonsDisabled(true);
    showAuthModal();
    finishAuth(null);
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    useDeviceLanguage(auth);
    await setPersistence(auth, browserLocalPersistence);

    try {
      await getRedirectResult(auth);
    } catch (error) {
      setMessage(getFriendlyAuthError(error), true);
    }

    onAuthStateChanged(auth, (user) => {
      currentUser = user || null;
      updateAuthUi(currentUser);
      finishAuth(currentUser);
      notifySubscribers(currentUser);
    });
  } catch (error) {
    elements.warning.hidden = false;
    setMessage(getFriendlyAuthError(error), true);
    setProviderButtonsDisabled(true);
    showAuthModal();
    finishAuth(null);
  }
}

function bindUi() {
  elements.buttons.forEach((button) => {
    button.addEventListener("click", signInWithGoogle);
  });
  elements.openButton?.addEventListener("click", showAuthModal);
  elements.signOutButton?.addEventListener("click", async () => {
    if (!auth) return;
    try {
      await signOut(auth);
      setMessage("ඔබ සාර්ථකව Sign Out විය.", false);
    } catch (error) {
      setMessage(getFriendlyAuthError(error), true);
    }
  });
}

async function signInWithGoogle() {
  if (!auth || !isConfigured) {
    showAuthModal();
    setMessage("මුලින් Firebase configuration එක සම්පූර්ණ කරන්න.", true);
    return;
  }

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  setProviderButtonsDisabled(true);
  setMessage("Account එකට සම්බන්ධ වෙමින්...", false);

  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error?.code)) {
      await signInWithRedirect(auth, provider);
      return;
    }
    setMessage(getFriendlyAuthError(error), true);
  } finally {
    setProviderButtonsDisabled(false);
  }
}

function updateAuthUi(user) {
  const signedIn = Boolean(user);
  elements.overlay.hidden = signedIn;
  elements.openButton.hidden = signedIn;
  elements.userMenu.hidden = !signedIn;

  if (!user) return;

  const displayName = user.displayName || user.email || "User";
  elements.userName.textContent = displayName;
  elements.userAvatar.textContent = getInitials(displayName);
  elements.userAvatar.title = displayName;
  setMessage("", false);
}

function getInitials(value) {
  const parts = String(value || "U").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("") || "U";
}

function setProviderButtonsDisabled(disabled) {
  elements.buttons.forEach((button) => { button.disabled = disabled; });
}

function setMessage(message, isError) {
  if (!elements.message) return;
  elements.message.textContent = message;
  elements.message.classList.toggle("error", Boolean(isError));
}

function finishAuth(user) {
  if (authResolved) return;
  authResolved = true;
  resolveReady(user);
}

function notifySubscribers(user) {
  subscribers.forEach((callback) => {
    try { callback(user); } catch (error) { console.error("Auth subscriber error", error); }
  });
}

function getFriendlyAuthError(error) {
  const code = error?.code || "";
  const messages = {
    "auth/popup-closed-by-user": "Login window එක අවසන් කිරීමට පෙර වසා ඇත.",
    "auth/cancelled-popup-request": "වෙනත් Login request එකක් දැනට ක්‍රියාත්මකයි.",
    "auth/account-exists-with-different-credential": "මෙම email එක වෙනත් Login ක්‍රමයකින් දැනටමත් භාවිතා කර ඇත.",
    "auth/unauthorized-domain": "මෙම website domain එක Firebase Authorized domains වෙත එක් කර නැත.",
    "auth/operation-not-allowed": "Google Login provider එක Firebase Console තුළ Enable කර නැත.",
    "auth/network-request-failed": "අන්තර්ජාල සම්බන්ධතාවය පරීක්ෂා කරන්න.",
    "auth/invalid-api-key": "Firebase API key එක වැරදියි.",
    "auth/internal-error": "Authentication සේවාවේ තාවකාලික දෝෂයක් ඇති විය."
  };
  return messages[code] || error?.message || "Login වීමට නොහැකි විය.";
}

export function waitForAuth() {
  return readyPromise;
}

export function getCurrentUser() {
  return currentUser;
}

export async function getIdToken(forceRefresh = false) {
  if (!currentUser) return "";
  return currentUser.getIdToken(forceRefresh);
}

export function showAuthModal() {
  elements.overlay.hidden = false;
}

export function subscribeAuth(callback) {
  subscribers.add(callback);
  if (authResolved) callback(currentUser);
  return () => subscribers.delete(callback);
}
