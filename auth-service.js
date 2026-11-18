const { initializeApp } = require("firebase/app");
const {
  initializeAuth, inMemoryPersistence, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, sendPasswordResetEmail, signOut, validatePassword,
  sendEmailVerification, reload, getIdToken,
} = require("firebase/auth");

let auth;
let verificationSentAt = 0;
let verificationUid = null;
function getAuth() {
  if (auth) return auth;
  const config = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    appId: process.env.FIREBASE_APP_ID,
  };
  if (Object.values(config).some(value => !value || value.startsWith("<"))) {
    throw Object.assign(new Error(), { code: "auth/missing-config" });
  }
  auth = initializeAuth(initializeApp(config), { persistence: inMemoryPersistence });
  return auth;
}

function emailValue(email) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw Object.assign(new Error(), { code: "auth/invalid-email" });
  }
  return email.trim();
}

function passwordValue(password) {
  if (typeof password !== "string" || !password) {
    throw Object.assign(new Error(), { code: "auth/missing-password" });
  }
  return password;
}

async function register(email, password) {
  email = emailValue(email);
  password = passwordValue(password);
  const client = getAuth();
  if (password.length < 8 || !(await validatePassword(client, password)).isValid) {
    throw Object.assign(new Error(), { code: "auth/weak-password" });
  }
  return (await createUserWithEmailAndPassword(client, email, password)).user;
}

async function login(email, password) {
  email = emailValue(email);
  password = passwordValue(password);
  return (await signInWithEmailAndPassword(getAuth(), email, password)).user;
}

async function resetPassword(email) {
  email = emailValue(email);
  try { await sendPasswordResetEmail(getAuth(), email); }
  catch (err) {
    // Give the same response whether an account exists or not.
    if (err.code !== "auth/user-not-found") throw err;
  }
}

function pendingUser() {
  const user = auth && auth.currentUser;
  if (!user) throw Object.assign(new Error(), { code: "auth/no-pending-user" });
  return user;
}

async function sendVerification() {
  const user = pendingUser();
  if (user.emailVerified) return;
  if (verificationUid === user.uid && Date.now() - verificationSentAt < 60000) {
    throw Object.assign(new Error(), { code: "auth/verification-cooldown" });
  }
  await sendEmailVerification(user);
  verificationUid = user.uid;
  verificationSentAt = Date.now();
}

async function checkVerification() {
  const user = pendingUser();
  await reload(user);
  if (user.emailVerified) await getIdToken(user, true);
  return user;
}

async function logout() {
  if (auth) await signOut(auth);
}

function errorMessage(err) {
  const messages = {
    "auth/no-pending-user": "Your verification session ended. Please sign in again.",
    "auth/verification-cooldown": "Please wait a minute before requesting another verification email.",
    "auth/missing-config": "Firebase is not configured. Check the root .env file and restart IRIS.",
    "auth/invalid-api-key": "Firebase configuration is invalid. Check the root .env file.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/missing-password": "Please enter your password.",
    "auth/weak-password": "Use at least 8 characters and meet the project's password requirements.",
    "auth/password-does-not-meet-requirements": "Your password does not meet the project's password requirements.",
    "auth/email-already-in-use": "Unable to create this account. Try signing in or resetting your password.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/user-not-found": "Email or password is incorrect.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/user-disabled": "This account is disabled. Contact your administrator.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/network-request-failed": "Unable to connect. Check your internet connection and try again.",
    "auth/operation-not-allowed": "Enable Email/Password in Firebase Authentication.",
  };
  return messages[err.code] || "Unable to complete authentication. Please try again.";
}

module.exports = { register, login, logout, resetPassword, sendVerification, checkVerification, pendingUser, errorMessage, projectId: () => process.env.FIREBASE_PROJECT_ID };
