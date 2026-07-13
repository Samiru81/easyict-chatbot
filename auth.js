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
  userPhoto: document.getElementById("userPhoto"),
  userInitials: document.getElementById("userInitials"),
  userName: document.getElementById("userName"),
  userEmail: document.getElementById("userEmail"),
  signOutButton: document.getElementById("signOutButton"),
  title: document.getElementById("authTitle"),
  intro: document.getElementById("authIntro"),
  googleText: document.getElementById("authGoogleText"),
  note: document.getElementById("authNote")
};

let auth = null;
let currentUser = null;
let authResolved = false;
const subscribers = new Set();
let resolveReady;
const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

const AUTH_TEXT = {
  si: {
    title: "Google Login / Sign Up",
    intro: "Chat Bot භාවිතා කිරීමට ඔබේ Google account එකෙන් ඇතුළත් වන්න.",
    warning: "Firebase setup එක තවම අවසන් කර නැත. <code>config.js</code> ගොනුව පරීක්ෂා කරන්න.",
    continueGoogle: "Continue with Google",
    note: "Google සහ Firebase Authentication හරහා account එක තහවුරු කරයි.",
    googleLogin: "Google Login",
    signOut: "Sign Out",
    configRequired: "Firebase configuration එක site/config.js ගොනුවට එක් කරන්න.",
    signedOut: "ඔබ සාර්ථකව Sign Out විය.",
    completeConfig: "මුලින් Firebase configuration එක සම්පූර්ණ කරන්න.",
    connecting: "Account එකට සම්බන්ධ වෙමින්..."
  },
  en: {
    title: "Google Login / Sign Up",
    intro: "Sign in with your Google account to use the Chat Bot.",
    warning: "Firebase setup is not complete. Check the <code>config.js</code> file.",
    continueGoogle: "Continue with Google",
    note: "Your account is verified through Google and Firebase Authentication.",
    googleLogin: "Google Login",
    signOut: "Sign out",
    configRequired: "Add the Firebase configuration to the site/config.js file.",
    signedOut: "You have signed out successfully.",
    completeConfig: "Complete the Firebase configuration first.",
    connecting: "Connecting to your account..."
  }
};

function authLanguage() {
  return document.body?.dataset?.answerLanguage === "en" ? "en" : "si";
}

function at(key) {
  return AUTH_TEXT[authLanguage()]?.[key] || AUTH_TEXT.si[key] || key;
}

function translateAuthUi() {
  if (elements.title) elements.title.textContent = at("title");
  if (elements.intro) elements.intro.textContent = at("intro");
  if (elements.warning) elements.warning.innerHTML = at("warning");
  if (elements.googleText) elements.googleText.textContent = at("continueGoogle");
  if (elements.note) elements.note.textContent = at("note");
  if (elements.openButton) elements.openButton.textContent = at("googleLogin");
  if (elements.signOutButton) {
    elements.signOutButton.title = at("signOut");
    elements.signOutButton.setAttribute("aria-label", at("signOut"));
  }
}

window.addEventListener("easyict-language-change", translateAuthUi);
translateAuthUi();

initialize();

async function initialize() {
  bindUi();

  if (!isConfigured) {
    elements.warning.hidden = false;
    setMessage(at("configRequired"), true);
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
      setMessage(at("signedOut"), false);
    } catch (error) {
      setMessage(getFriendlyAuthError(error), true);
    }
  });
}

async function signInWithGoogle() {
  if (!auth || !isConfigured) {
    showAuthModal();
    setMessage(at("completeConfig"), true);
    return;
  }

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  setProviderButtonsDisabled(true);
  setMessage(at("connecting"), false);

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
  const email = user.email || "easyict account";
  const photoURL = user.photoURL || "";
  elements.userName.textContent = displayName;
  if (elements.userEmail) elements.userEmail.textContent = email;
  if (elements.userInitials) elements.userInitials.textContent = getInitials(displayName);
  if (elements.userPhoto) {
    if (photoURL) {
      elements.userPhoto.src = photoURL;
      elements.userPhoto.hidden = false;
      if (elements.userInitials) elements.userInitials.hidden = true;
    } else {
      elements.userPhoto.removeAttribute("src");
      elements.userPhoto.hidden = true;
      if (elements.userInitials) elements.userInitials.hidden = false;
    }
  }
  elements.userAvatar.title = `${displayName}${email ? `
${email}` : ""}`;
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
  const english = authLanguage() === "en";
  const messages = english ? {
    "auth/popup-closed-by-user": "The login window was closed before sign-in was completed.",
    "auth/cancelled-popup-request": "Another login request is already in progress.",
    "auth/account-exists-with-different-credential": "This email is already used with another sign-in method.",
    "auth/unauthorized-domain": "This website domain is not added to Firebase Authorized domains.",
    "auth/operation-not-allowed": "The Google Login provider is not enabled in Firebase Console.",
    "auth/network-request-failed": "Check your internet connection.",
    "auth/invalid-api-key": "The Firebase API key is invalid.",
    "auth/internal-error": "The Authentication service has a temporary error."
  } : {
    "auth/popup-closed-by-user": "Login window එක අවසන් කිරීමට පෙර වසා ඇත.",
    "auth/cancelled-popup-request": "වෙනත් Login request එකක් දැනට ක්‍රියාත්මකයි.",
    "auth/account-exists-with-different-credential": "මෙම email එක වෙනත් Login ක්‍රමයකින් දැනටමත් භාවිතා කර ඇත.",
    "auth/unauthorized-domain": "මෙම website domain එක Firebase Authorized domains වෙත එක් කර නැත.",
    "auth/operation-not-allowed": "Google Login provider එක Firebase Console තුළ Enable කර නැත.",
    "auth/network-request-failed": "අන්තර්ජාල සම්බන්ධතාවය පරීක්ෂා කරන්න.",
    "auth/invalid-api-key": "Firebase API key එක වැරදියි.",
    "auth/internal-error": "Authentication සේවාවේ තාවකාලික දෝෂයක් ඇති විය."
  };
  return messages[code] || error?.message || (english ? "Unable to sign in." : "Login වීමට නොහැකි විය.");
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
