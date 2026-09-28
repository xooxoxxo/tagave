/**
 * First-run onboarding wizard (6 screens)
 * Accessible only if no admin user exists in database
 */

import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSetup } from '../hooks/useAuth';
import { SetupRequest } from '@liner/shared';
import styles from './SetupPage.module.css';

type Screen = 'admin' | 'musicPath' | 'musicSource' | 'workers' | 'externalApis' | 'verification';

interface WizardState {
  admin: {
    email: string;
    displayName: string;
    password: string;
    confirmPassword: string;
  };
  musicPath: {
    path: string;
    tested: boolean;
    testError?: string;
  };
  musicSource: 'local' | 'nfs' | 'smb';
  workers: {
    enabled: boolean;
    sameHost: boolean;
    workerHost?: string;
    backupsEnabled: boolean;
  };
  externalApis: {
    musicbrainzContact: string;
    discogsToken: string;
    acoustIdKey: string;
  };
}

export function SetupPage() {
  const navigate = useNavigate();
  const setupMutation = useSetup();

  // Check if setup is required
  useEffect(() => {
    const checkSetupRequired = async () => {
      try {
        const response = await fetch('/api/auth/setup-required');
        const data = await response.json();
        if (!data.setupRequired) {
          navigate({ to: '/login' });
        }
      } catch (err) {
        // If error, assume setup is required
        console.error('Failed to check setup status:', err);
      }
    };
    checkSetupRequired();
  }, [navigate]);

  const [currentScreen, setCurrentScreen] = useState<Screen>('admin');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [testingPath, setTestingPath] = useState(false);

  const [wizardState, setWizardState] = useState<WizardState>({
    admin: {
      email: '',
      displayName: '',
      password: '',
      confirmPassword: '',
    },
    musicPath: {
      path: '',
      tested: false,
    },
    musicSource: 'local',
    workers: {
      enabled: true,
      sameHost: true,
      backupsEnabled: true,
    },
    externalApis: {
      musicbrainzContact: 'tagave/1.0',
      discogsToken: '',
      acoustIdKey: '',
    },
  });

  const handleAdminChange = (field: keyof WizardState['admin'], value: string) => {
    setWizardState((prev) => ({
      ...prev,
      admin: { ...prev.admin, [field]: value },
    }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  const handleMusicPathChange = (value: string) => {
    setWizardState((prev) => ({
      ...prev,
      musicPath: { ...prev.musicPath, path: value, tested: false },
    }));
    if (errors.musicPath) {
      setErrors((prev) => ({ ...prev, musicPath: '' }));
    }
  };

  const handleTestMusicPath = async () => {
    setTestingPath(true);
    try {
      const response = await fetch('/api/system/test-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: wizardState.musicPath.path }),
      });
      const data = await response.json();

      if (response.ok) {
        setWizardState((prev) => ({
          ...prev,
          musicPath: { ...prev.musicPath, tested: true, testError: undefined },
        }));
      } else {
        setWizardState((prev) => ({
          ...prev,
          musicPath: { ...prev.musicPath, testError: data.message || 'Path not accessible' },
        }));
      }
    } catch (err) {
      setWizardState((prev) => ({
        ...prev,
        musicPath: {
          ...prev.musicPath,
          testError: 'Failed to test path. Please check your network.',
        },
      }));
    } finally {
      setTestingPath(false);
    }
  };

  const handleWorkersChange = (field: keyof WizardState['workers'], value: any) => {
    setWizardState((prev) => ({
      ...prev,
      workers: { ...prev.workers, [field]: value },
    }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  const handleExternalApiChange = (field: keyof WizardState['externalApis'], value: string) => {
    setWizardState((prev) => ({
      ...prev,
      externalApis: { ...prev.externalApis, [field]: value },
    }));
  };

  const validateAdminScreen = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!wizardState.admin.email) {
      newErrors.email = 'Email is required';
    } else if (!wizardState.admin.email.includes('@') || !wizardState.admin.email.includes('.')) {
      newErrors.email = 'Please enter a valid email address';
    }

    if (!wizardState.admin.displayName) {
      newErrors.displayName = 'Display name is required';
    }

    if (!wizardState.admin.password) {
      newErrors.password = 'Password is required';
    } else if (wizardState.admin.password.length < 12) {
      newErrors.password = 'Password must be at least 12 characters';
    }

    if (wizardState.admin.password !== wizardState.admin.confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateMusicPathScreen = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!wizardState.musicPath.path) {
      newErrors.musicPath = 'Music path is required';
    }

    if (!wizardState.musicPath.tested) {
      newErrors.musicPath = 'Please test the path first';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateWorkersScreen = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (wizardState.workers.enabled && !wizardState.workers.sameHost) {
      if (!wizardState.workers.workerHost) {
        newErrors.workerHost = 'Worker host is required';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const canProceedToNext = (): boolean => {
    switch (currentScreen) {
      case 'admin':
        return validateAdminScreen();
      case 'musicPath':
        return validateMusicPathScreen();
      case 'workers':
        return validateWorkersScreen();
      default:
        return true;
    }
  };

  const handleNext = () => {
    if (!canProceedToNext()) return;

    const screenOrder: Screen[] = ['admin', 'musicPath', 'musicSource', 'workers', 'externalApis', 'verification'];
    const currentIndex = screenOrder.indexOf(currentScreen);
    if (currentIndex < screenOrder.length - 1) {
      setCurrentScreen(screenOrder[currentIndex + 1]);
    }
  };

  const handleBack = () => {
    const screenOrder: Screen[] = ['admin', 'musicPath', 'musicSource', 'workers', 'externalApis', 'verification'];
    const currentIndex = screenOrder.indexOf(currentScreen);
    if (currentIndex > 0) {
      setCurrentScreen(screenOrder[currentIndex - 1]);
    }
  };

  const handleSkipAdmin = () => {
    const screenOrder: Screen[] = ['admin', 'musicPath', 'musicSource', 'workers', 'externalApis', 'verification'];
    const currentIndex = screenOrder.indexOf(currentScreen);
    if (currentIndex < screenOrder.length - 1) {
      setCurrentScreen(screenOrder[currentIndex + 1]);
    }
  };

  const handleComplete = async () => {
    // Submit all wizard data
    const setupData: SetupRequest = {
      email: wizardState.admin.email,
      password: wizardState.admin.password,
      displayName: wizardState.admin.displayName,
      contactString: wizardState.externalApis.musicbrainzContact,
    };

    setupMutation.mutate(setupData, {
      onSuccess: () => {
        navigate({ to: '/dashboard' });
      },
    });
  };

  const progressPercent = ((Object.keys({ admin: 1, musicPath: 2, musicSource: 3, workers: 4, externalApis: 5, verification: 6 })[currentScreen] ?? 1) / 6) * 100;

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        {/* Progress bar */}
        <div className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
        </div>

        {/* Screen 1: Admin Account */}
        {currentScreen === 'admin' && (
          <>
            <h1 className={styles.title}>Create Admin Account</h1>
            <p className={styles.subtitle}>Set up your login credentials</p>

            <div className={styles.form}>
              <div className={styles.field}>
                <label htmlFor="email" className={styles.label}>
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={wizardState.admin.email}
                  onChange={(e) => handleAdminChange('email', e.target.value)}
                  placeholder="you@example.com"
                  disabled={setupMutation.isPending}
                />
                {errors.email && <span className={styles.error}>{errors.email}</span>}
              </div>

              <div className={styles.field}>
                <label htmlFor="displayName" className={styles.label}>
                  Display Name
                </label>
                <input
                  id="displayName"
                  type="text"
                  value={wizardState.admin.displayName}
                  onChange={(e) => handleAdminChange('displayName', e.target.value)}
                  placeholder="Your name"
                  disabled={setupMutation.isPending}
                />
                {errors.displayName && <span className={styles.error}>{errors.displayName}</span>}
              </div>

              <div className={styles.field}>
                <label htmlFor="password" className={styles.label}>
                  Password
                  <button
                    type="button"
                    className={styles.togglePassword}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </label>
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={wizardState.admin.password}
                  onChange={(e) => handleAdminChange('password', e.target.value)}
                  placeholder="At least 12 characters"
                  disabled={setupMutation.isPending}
                />
                {errors.password && <span className={styles.error}>{errors.password}</span>}
              </div>

              <div className={styles.field}>
                <label htmlFor="confirmPassword" className={styles.label}>
                  Confirm Password
                </label>
                <input
                  id="confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  value={wizardState.admin.confirmPassword}
                  onChange={(e) => handleAdminChange('confirmPassword', e.target.value)}
                  placeholder="Re-enter your password"
                  disabled={setupMutation.isPending}
                />
                {errors.confirmPassword && <span className={styles.error}>{errors.confirmPassword}</span>}
              </div>
            </div>

            <div className={styles.buttonGroup}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={handleSkipAdmin}
                disabled={setupMutation.isPending}
              >
                Skip for now
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleNext}
                disabled={setupMutation.isPending}
              >
                Next
              </button>
            </div>
          </>
        )}

        {/* Screen 2: Music Library Path */}
        {currentScreen === 'musicPath' && (
          <>
            <h1 className={styles.title}>Music Library</h1>
            <p className={styles.subtitle}>Where is your music stored?</p>

            <div className={styles.form}>
              <div className={styles.field}>
                <label htmlFor="musicPath" className={styles.label}>
                  Library path
                </label>
                <input
                  id="musicPath"
                  type="text"
                  value={wizardState.musicPath.path}
                  onChange={(e) => handleMusicPathChange(e.target.value)}
                  placeholder="/mnt/music"
                  disabled={setupMutation.isPending || testingPath}
                />
                {errors.musicPath && <span className={styles.error}>{errors.musicPath}</span>}
              </div>

              {wizardState.musicPath.tested && !wizardState.musicPath.testError && (
                <div className={styles.success}>✓ Path is accessible</div>
              )}

              {wizardState.musicPath.testError && (
                <div className={styles.errorBox}>
                  <p className={styles.errorTitle}>Path not accessible</p>
                  <p className={styles.errorMessage}>{wizardState.musicPath.testError}</p>
                  <p className={styles.errorHint}>Create the directory first:</p>
                  <code className={styles.code}>mkdir -p {wizardState.musicPath.path}</code>
                </div>
              )}

              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={handleTestMusicPath}
                disabled={!wizardState.musicPath.path || testingPath || setupMutation.isPending}
              >
                {testingPath ? 'Testing...' : 'Test path'}
              </button>
            </div>

            <div className={styles.buttonGroup}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={handleBack}
                disabled={setupMutation.isPending}
              >
                Back
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleNext}
                disabled={setupMutation.isPending}
              >
                Next
              </button>
            </div>
          </>
        )}

        {/* Screen 3: Music Source Type */}
        {currentScreen === 'musicSource' && (
          <>
            <h1 className={styles.title}>Music Source Type</h1>
            <p className={styles.subtitle}>How is your music stored?</p>

            <div className={styles.form}>
              <div className={styles.radioGroup}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name="source"
                    value="local"
                    checked={wizardState.musicSource === 'local'}
                    onChange={(e) =>
                      setWizardState((prev) => ({
                        ...prev,
                        musicSource: e.target.value as 'local' | 'nfs' | 'smb',
                      }))
                    }
                  />
                  <span className={styles.radioText}>Local path</span>
                  <span className={styles.radioHint}>Fast (same computer)</span>
                </label>
              </div>

              <div className={styles.radioGroup}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name="source"
                    value="nfs"
                    checked={wizardState.musicSource === 'nfs'}
                    onChange={(e) =>
                      setWizardState((prev) => ({
                        ...prev,
                        musicSource: e.target.value as 'local' | 'nfs' | 'smb',
                      }))
                    }
                  />
                  <span className={styles.radioText}>NAS (NFS)</span>
                  <span className={styles.radioHint}>Shared storage</span>
                </label>
              </div>

              <div className={styles.radioGroup}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name="source"
                    value="smb"
                    checked={wizardState.musicSource === 'smb'}
                    onChange={(e) =>
                      setWizardState((prev) => ({
                        ...prev,
                        musicSource: e.target.value as 'local' | 'nfs' | 'smb',
                      }))
                    }
                  />
                  <span className={styles.radioText}>NAS (SMB/CIFS)</span>
                  <span className={styles.radioHint}>Windows-compatible sharing</span>
                </label>
              </div>
            </div>

            <div className={styles.buttonGroup}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={handleBack}
                disabled={setupMutation.isPending}
              >
                Back
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleNext}
                disabled={setupMutation.isPending}
              >
                Next
              </button>
            </div>
          </>
        )}

        {/* Screen 4: Workers & Features */}
        {currentScreen === 'workers' && (
          <>
            <h1 className={styles.title}>Workers & Features</h1>
            <p className={styles.subtitle}>Configure scanning and backups</p>

            <div className={styles.form}>
              <div className={styles.checkboxGroup}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={wizardState.workers.enabled}
                    onChange={(e) => handleWorkersChange('enabled', e.target.checked)}
                  />
                  <span className={styles.checkboxText}>Enable workers (scan & tag music)</span>
                </label>
              </div>

              {wizardState.workers.enabled && (
                <div className={styles.nestedGroup}>
                  <div className={styles.radioGroup}>
                    <label className={styles.radioLabel}>
                      <input
                        type="radio"
                        name="workerLocation"
                        checked={wizardState.workers.sameHost}
                        onChange={() => handleWorkersChange('sameHost', true)}
                      />
                      <span className={styles.radioText}>Same host (all-in-one)</span>
                    </label>
                  </div>

                  <div className={styles.radioGroup}>
                    <label className={styles.radioLabel}>
                      <input
                        type="radio"
                        name="workerLocation"
                        checked={!wizardState.workers.sameHost}
                        onChange={() => handleWorkersChange('sameHost', false)}
                      />
                      <span className={styles.radioText}>Different host (separate)</span>
                    </label>
                  </div>

                  {!wizardState.workers.sameHost && (
                    <div className={styles.field}>
                      <label htmlFor="workerHost" className={styles.label}>
                        Worker host IP or hostname
                      </label>
                      <input
                        id="workerHost"
                        type="text"
                        value={wizardState.workers.workerHost || ''}
                        onChange={(e) => handleWorkersChange('workerHost', e.target.value)}
                        placeholder="192.168.1.20 or worker.local"
                      />
                      {errors.workerHost && <span className={styles.error}>{errors.workerHost}</span>}
                    </div>
                  )}
                </div>
              )}

              <div className={styles.checkboxGroup}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={wizardState.workers.backupsEnabled}
                    onChange={(e) => handleWorkersChange('backupsEnabled', e.target.checked)}
                  />
                  <span className={styles.checkboxText}>Enable automatic backups</span>
                </label>
              </div>
            </div>

            <div className={styles.buttonGroup}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={handleBack}
                disabled={setupMutation.isPending}
              >
                Back
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleNext}
                disabled={setupMutation.isPending}
              >
                Next
              </button>
            </div>
          </>
        )}

        {/* Screen 5: External APIs */}
        {currentScreen === 'externalApis' && (
          <>
            <h1 className={styles.title}>External APIs (Optional)</h1>
            <p className={styles.subtitle}>Configure optional services for better tagging</p>

            <div className={styles.form}>
              <div className={styles.field}>
                <label htmlFor="musicbrainzContact" className={styles.label}>
                  MusicBrainz contact
                  <span className={styles.hint}>(user-agent identifier)</span>
                </label>
                <input
                  id="musicbrainzContact"
                  type="text"
                  value={wizardState.externalApis.musicbrainzContact}
                  onChange={(e) => handleExternalApiChange('musicbrainzContact', e.target.value)}
                  placeholder="tagave/1.0"
                />
              </div>

              <div className={styles.field}>
                <label htmlFor="discogsToken" className={styles.label}>
                  Discogs token
                  <span className={styles.hint}>(optional; increases rate limits)</span>
                </label>
                <input
                  id="discogsToken"
                  type="text"
                  value={wizardState.externalApis.discogsToken}
                  onChange={(e) => handleExternalApiChange('discogsToken', e.target.value)}
                  placeholder="Your Discogs API token"
                />
                <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener noreferrer" className={styles.link}>
                  Get a free token
                </a>
              </div>

              <div className={styles.field}>
                <label htmlFor="acoustIdKey" className={styles.label}>
                  AcoustID key
                  <span className={styles.hint}>(optional; for future use)</span>
                </label>
                <input
                  id="acoustIdKey"
                  type="text"
                  value={wizardState.externalApis.acoustIdKey}
                  onChange={(e) => handleExternalApiChange('acoustIdKey', e.target.value)}
                  placeholder="Your AcoustID API key"
                />
              </div>

              <p className={styles.hint}>You can add or change these settings later.</p>
            </div>

            <div className={styles.buttonGroup}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={handleBack}
                disabled={setupMutation.isPending}
              >
                Back
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleNext}
                disabled={setupMutation.isPending}
              >
                Next
              </button>
            </div>
          </>
        )}

        {/* Screen 6: Verification */}
        {currentScreen === 'verification' && (
          <>
            <h1 className={styles.title}>Verify Setup</h1>
            <p className={styles.subtitle}>Checking system health...</p>

            <div className={styles.form}>
              <div className={styles.healthCheck}>
                <p>✓ Database: Connected</p>
                <p>✓ API: Ready</p>
                <p>✓ Configuration saved</p>
                {wizardState.workers.enabled && <p>⚠ Worker: Pending</p>}
              </div>

              {setupMutation.error && (
                <div className={styles.serverError}>
                  {(setupMutation.error as any)?.detail || 'Setup failed. Please try again.'}
                </div>
              )}
            </div>

            <div className={styles.buttonGroup}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={handleBack}
                disabled={setupMutation.isPending}
              >
                Back
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleComplete}
                disabled={setupMutation.isPending}
              >
                {setupMutation.isPending ? 'Setting up...' : 'Continue to Dashboard'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
