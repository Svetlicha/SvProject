(function initSupabaseAuth() {
  'use strict';

  const APP_SCRIPTS = Object.freeze({
    desktop: [
      'assets/section-loader.js',
      'assets/algara-prices-v26-lite-data.js',
      'assets/algara-lite-calculator.js',
      'assets/desktop.js?v=20260825-release-date-1'
    ],
    mobile: [
      'assets/section-loader.js',
      'assets/algara-prices-v26-lite-data.js',
      'assets/algara-lite-calculator.js',
      'assets/mobile.js?v=20260824-sidebar-arrow-1'
    ]
  });

  const gate = document.getElementById('svLoginGate');
  const form = document.getElementById('svLoginForm');
  const usernameInput = document.getElementById('svLoginUsername');
  const passwordInput = document.getElementById('svLoginPassword');
  const passwordToggle = document.getElementById('svPasswordToggle');
  const rememberInput = document.getElementById('svRememberLogin');
  const submitButton = document.getElementById('svLoginSubmit');
  const errorBox = document.getElementById('svLoginError');
  const appShell = document.getElementById('appShell');
  const config = window.SV_SUPABASE_CONFIG || {};
  let client = null;
  let appStarted = false;
  let statusResetTimer = null;
  const REMEMBER_PREFERENCE_KEY = 'sv_auth_remember_v1';
  const REMEMBERED_USERNAME_KEY = 'sv_auth_username_v1';
  let rememberSession = readStoredValue('localStorage', REMEMBER_PREFERENCE_KEY) !== '0';

  function getBrowserStorage(name) {
    try {
      return window[name] || null;
    } catch (_) {
      return null;
    }
  }

  function readStoredValue(storageName, key) {
    try {
      const storage = getBrowserStorage(storageName);
      return storage ? storage.getItem(key) : null;
    } catch (_) {
      return null;
    }
  }

  function writeStoredValue(storageName, key, value) {
    try {
      const storage = getBrowserStorage(storageName);
      if (storage) storage.setItem(key, value);
    } catch (_) { }
  }

  function removeStoredValue(storageName, key) {
    try {
      const storage = getBrowserStorage(storageName);
      if (storage) storage.removeItem(key);
    } catch (_) { }
  }

  function createAuthStorage() {
    return {
      getItem(key) {
        if (rememberSession) {
          return readStoredValue('localStorage', key) || readStoredValue('sessionStorage', key);
        }
        removeStoredValue('localStorage', key);
        return readStoredValue('sessionStorage', key);
      },
      setItem(key, value) {
        const target = rememberSession ? 'localStorage' : 'sessionStorage';
        const other = rememberSession ? 'sessionStorage' : 'localStorage';
        writeStoredValue(target, key, value);
        removeStoredValue(other, key);
      },
      removeItem(key) {
        removeStoredValue('localStorage', key);
        removeStoredValue('sessionStorage', key);
      }
    };
  }

  function setupRememberLogin() {
    if (!rememberInput) return;
    rememberInput.checked = rememberSession;
    if (rememberSession) {
      const rememberedUsername = readStoredValue('localStorage', REMEMBERED_USERNAME_KEY);
      if (rememberedUsername) usernameInput.value = rememberedUsername;
    }
    rememberInput.addEventListener('change', () => {
      rememberSession = rememberInput.checked;
      writeStoredValue('localStorage', REMEMBER_PREFERENCE_KEY, rememberSession ? '1' : '0');
      if (!rememberSession) removeStoredValue('localStorage', REMEMBERED_USERNAME_KEY);
    });
  }

  function saveRememberPreference(email) {
    rememberSession = Boolean(rememberInput && rememberInput.checked);
    writeStoredValue('localStorage', REMEMBER_PREFERENCE_KEY, rememberSession ? '1' : '0');
    if (rememberSession) writeStoredValue('localStorage', REMEMBERED_USERNAME_KEY, email);
    else removeStoredValue('localStorage', REMEMBERED_USERNAME_KEY);
  }

  function delay(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }

  function isRetryableLoadError(error) {
    const cause = error && error.cause ? error.cause : {};
    const status = Number(error && error.status) || Number(cause && cause.status) || 0;
    const text = `${error && error.message ? error.message : ''} ${cause && cause.message ? cause.message : ''}`;
    if (status === 401 || status === 403) return false;
    return !/(invalid\s+jwt|jwt\s+expired|permission\s+denied|row.level.security|unauthorized|forbidden)/i.test(text);
  }

  async function loadProtectedState(store) {
    const maxAttempts = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const loaded = await store.loadState();
        if (attempt > 1) console.info(`Supabase data loaded on attempt ${attempt}.`);
        return loaded;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !isRetryableLoadError(error)) throw error;
        console.warn(`Supabase load attempt ${attempt} failed; retrying.`, error);
        setBusy(true, `Свързвам отново (${attempt + 1}/${maxAttempts})...`);
        await delay(700 * attempt);
      }
    }
    throw lastError;
  }

  function renderIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons({ attrs: { 'stroke-width': 2 } });
    }
  }

  function setError(message) {
    if (errorBox) errorBox.textContent = message || '';
  }

  function setBusy(busy, label) {
    if (!submitButton) return;
    submitButton.disabled = Boolean(busy);
    submitButton.textContent = label || (busy ? 'Влизам...' : 'Вход');
  }

  function validConfig() {
    return Boolean(
      /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(config.url || '').trim()) &&
      String(config.publishableKey || '').trim()
    );
  }

  async function loadScript(src) {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = src;
          script.defer = false;
          script.onload = resolve;
          script.onerror = () => {
            script.remove();
            reject(new Error(`Не успях да заредя ${src}.`));
          };
          document.body.appendChild(script);
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await delay(500);
      }
    }
    throw lastError;
  }

  async function loadApplicationScripts() {
    const appName = document.body.dataset.svApp || 'desktop';
    const scripts = APP_SCRIPTS[appName] || APP_SCRIPTS.desktop;
    for (const src of scripts) await loadScript(src);
  }

  function installLogoutButton() {
    const header = appShell && appShell.querySelector('header');
    if (!header || header.querySelector('.sv-logout-button')) return;
    const button = document.createElement('button');
    button.className = 'sv-logout-button no-print';
    button.type = 'button';
    button.title = 'Изход';
    button.setAttribute('aria-label', 'Изход');
    button.innerHTML = '<i data-lucide="log-out" aria-hidden="true"></i>';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        if (window.SVCloud && typeof window.SVCloud.flush === 'function') {
          await window.SVCloud.flush();
        }
      } catch (error) {
        console.warn('Final cloud save skipped:', error);
      }
      await client.auth.signOut();
      window.location.reload();
    });
    header.appendChild(button);
    renderIcons();
  }

  function configureCloudControls() {
    const cloudBox = document.querySelector('.cloud-sync');
    if (!cloudBox) return;
    const title = cloudBox.querySelector('.cloud-sync-title h3');
    if (title) title.textContent = 'Supabase';
    const urlToggle = document.getElementById('toggleGoogleUrlBtn');
    const urlSettings = document.getElementById('googleUrlSettings');
    const testButton = document.getElementById('testGoogleSyncBtn');
    if (urlToggle) urlToggle.hidden = true;
    if (urlSettings) urlSettings.hidden = true;
    if (testButton) testButton.hidden = true;
    const loadButton = document.getElementById('loadGoogleSyncBtn');
    if (loadButton) loadButton.textContent = 'Презареди';
    const backupsTitle = cloudBox.querySelector('.google-backups-head strong');
    if (backupsTitle) backupsTitle.textContent = 'Supabase backups';
    const status = document.getElementById('googleSyncStatus');
    if (status) {
      status.textContent = 'Защитената връзка със Supabase е активна.';
      status.className = 'cloud-status ok';
    }
    updateLastSupabaseSave(window.SVCloud && window.SVCloud.updatedAt);
    const notice = document.querySelector('.sidebar .notice');
    if (notice) notice.textContent = 'Данните се зареждат и записват защитено в Supabase. Експортът остава допълнително локално копие.';
  }

  function updateLastSupabaseSave(value) {
    const label = document.getElementById('supabaseLastSave');
    if (!label) return;
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      label.hidden = true;
      label.textContent = '';
      return;
    }
    label.textContent = `Последен запис в Supabase: ${date.toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    label.hidden = false;
  }

  function handleCloudStatus(event) {
    const status = document.getElementById('googleSyncStatus');
    const detail = event && event.detail ? event.detail : {};
    if (!status || !detail.message) return;
    if (statusResetTimer) clearTimeout(statusResetTimer);
    status.textContent = detail.message;
    status.className = `cloud-status ${detail.phase === 'error' ? 'error' : detail.phase === 'saved' || detail.phase === 'loaded' ? 'ok' : ''}`.trim();
    if ((detail.phase === 'saved' || detail.phase === 'loaded') && detail.updatedAt) {
      if (window.SVCloud) window.SVCloud.updatedAt = detail.updatedAt;
      updateLastSupabaseSave(detail.updatedAt);
    }
    if (detail.phase === 'saved') {
      statusResetTimer = setTimeout(() => {
        statusResetTimer = null;
        status.textContent = 'Supabase е свързан.';
        status.className = 'cloud-status ok';
      }, 2500);
    }
  }

  async function revealApplication(session) {
    if (appStarted) return;
    if (!session || !session.user) throw new Error('Липсва валидна сесия.');
    appStarted = true;
    setBusy(true, 'Зареждам...');
    setError('');

    try {
      const store = window.SVStateStore.create(client, session.user);
      const loaded = await loadProtectedState(store);
      window.__SV_CLOUD_INITIAL_STATE__ = loaded.state;
      window.SVCloud = {
        active: true,
        user: session.user,
        updatedAt: loaded.updatedAt,
        scheduleSave(state) {
          store.scheduleSave(state);
        },
        saveNow(state, options) {
          return store.saveNow(state, options);
        },
        async flush() {
          if (!store.pendingState) return { ok: true, skipped: true };
          return store.saveNow(store.pendingState);
        },
        listBackups() {
          return store.listBackups();
        },
        getBackup(id) {
          return store.getBackup(id);
        },
        reload() {
          window.location.reload();
        }
      };

      appShell.hidden = false;
      appShell.removeAttribute('inert');
      document.body.classList.remove('sv-auth-pending');
      document.body.classList.add('sv-authenticated');
      gate.hidden = true;
      await loadApplicationScripts();
      configureCloudControls();
      installLogoutButton();
    } catch (error) {
      appStarted = false;
      console.error('Protected app startup failed:', error);
      appShell.hidden = true;
      appShell.setAttribute('inert', '');
      document.body.classList.add('sv-auth-pending');
      document.body.classList.remove('sv-authenticated');
      gate.hidden = false;
      setBusy(false, 'Вход');
      setError('Не успях да заредя защитените данни. Провери връзката и опитай отново.');
      throw error;
    }
  }

  async function signIn(event) {
    event.preventDefault();
    setError('');

    const email = String(usernameInput.value || '').trim().toLocaleLowerCase('en-US');
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Невалидно име или парола.');
      passwordInput.value = '';
      usernameInput.focus();
      return;
    }

    saveRememberPreference(email);
    setBusy(true, 'Влизам...');
    let result;
    try {
      result = await client.auth.signInWithPassword({
        email,
        password: passwordInput.value
      });
    } catch (error) {
      console.error('Supabase sign-in request failed:', error);
      setBusy(false, 'Вход');
      setError('Няма връзка със Supabase. Провери интернет връзката и опитай отново.');
      return;
    }

    if (result.error || !result.data || !result.data.session) {
      setBusy(false, 'Вход');
      setError('Невалидно име или парола.');
      passwordInput.value = '';
      passwordInput.focus();
      return;
    }

    passwordInput.value = '';
    try {
      await revealApplication(result.data.session);
    } catch (_) {
      // revealApplication restores the login screen and shows the user-facing error.
    }
  }

  function setupPasswordToggle() {
    if (!passwordToggle || !passwordInput) return;
    passwordToggle.addEventListener('click', () => {
      const show = passwordInput.type === 'password';
      passwordInput.type = show ? 'text' : 'password';
      passwordToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      passwordToggle.setAttribute('aria-label', show ? 'Скрий паролата' : 'Покажи паролата');
      passwordToggle.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}" aria-hidden="true"></i>`;
      renderIcons();
      passwordInput.focus();
    });
  }

  async function boot() {
    window.addEventListener('sv-cloud-status', handleCloudStatus);
    setupPasswordToggle();
    setupRememberLogin();
    renderIcons();

    if (!validConfig() || !window.supabase || !window.SVStateStore) {
      setBusy(false, 'Вход');
      setError('Защитената връзка още не е конфигурирана.');
      return;
    }

    client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: createAuthStorage()
      }
    });
    window.SVSupabase = client;
    form.addEventListener('submit', signIn);

    let sessionResult;
    try {
      sessionResult = await client.auth.getSession();
    } catch (error) {
      console.error('Supabase session check failed:', error);
      setBusy(false, 'Вход');
      setError('Не успях да проверя сесията. Провери интернет връзката и опитай отново.');
      return;
    }
    if (sessionResult.error) {
      setError('Не успях да проверя сесията.');
      return;
    }
    if (sessionResult.data && sessionResult.data.session) {
      await revealApplication(sessionResult.data.session);
      return;
    }

    setBusy(false, 'Вход');
    usernameInput.focus();
  }

  boot().catch(error => console.error(error));
})();
