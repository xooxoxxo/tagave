/**
 * Settings page for scan roots management (LIB-1)
 * Add, edit, enable/disable scan roots
 */

import { useState } from 'react';
import { useCurrentLibrary, useScanRoots, useCreateScanRoot, useUpdateScanRoot, useDeleteScanRoot, useStartScan, useValidateScanRoot } from '../hooks';
import { SettingsNav } from '../components/SettingsNav';
import { ScanRoot } from '@liner/shared';
import styles from './SettingsScanRootsPage.module.css';

export function SettingsScanRootsPage() {
  const { libraryId } = useCurrentLibrary();
  const { data: scanRoots = [], isLoading } = useScanRoots(libraryId);
  const createMutation = useCreateScanRoot(libraryId);
  const updateMutation = useUpdateScanRoot(libraryId);
  const deleteMutation = useDeleteScanRoot(libraryId);
  const startScanMutation = useStartScan(libraryId);
  const validateMutation = useValidateScanRoot(libraryId);

  const [showAddForm, setShowAddForm] = useState(false);
  const [pendingRootIds, setPendingRootIds] = useState<Set<string>>(new Set());
  const [formData, setFormData] = useState({
    path: '',
    displayName: '',
    writable: true,
    pollIntervalS: 21600, // 6 hours
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isPending = (rootId: string) => pendingRootIds.has(rootId);

  const withPending = (rootId: string, fn: () => void) => {
    setPendingRootIds((prev) => new Set(prev).add(rootId));
    fn();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : type === 'number' ? Number(value) : value,
    }));
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.path.trim()) {
      newErrors.path = 'Path is required';
    } else if (!formData.path.startsWith('/')) {
      newErrors.path = 'Path must be absolute (start with /)';
    }

    if (!formData.displayName.trim()) {
      newErrors.displayName = 'Display name is required';
    }

    if (formData.pollIntervalS < 60) {
      newErrors.pollIntervalS = 'Poll interval must be at least 60 seconds';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleAddRoot = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;

    createMutation.mutate(
      {
        path: formData.path,
        displayName: formData.displayName,
        writable: formData.writable,
        pollIntervalS: formData.pollIntervalS,
        enabled: true,
      },
      {
        onSuccess: () => {
          setFormData({ path: '', displayName: '', writable: true, pollIntervalS: 21600 });
          setShowAddForm(false);
          setErrors({});
        },
      }
    );
  };

  const clearPending = (rootId: string) => () =>
    setPendingRootIds((prev) => {
      const next = new Set(prev);
      next.delete(rootId);
      return next;
    });

  const handleToggleEnabled = (root: ScanRoot) => {
    withPending(root.id, () => {
      updateMutation.mutate({ rootId: root.id, data: { enabled: !root.enabled } }, { onSettled: clearPending(root.id) });
    });
  };

  const handleDelete = (rootId: string) => {
    if (confirm('Delete this scan root? Files will not be removed.')) {
      withPending(rootId, () => {
        deleteMutation.mutate(rootId, { onSettled: clearPending(rootId) });
      });
    }
  };

  const handleStartScan = (rootId: string) => {
    withPending(rootId, () => {
      startScanMutation.mutate(rootId, { onSettled: clearPending(rootId) });
    });
  };

  const handleValidate = (rootId: string) => {
    withPending(rootId, () => {
      validateMutation.mutate(rootId, { onSettled: clearPending(rootId) });
    });
  };

  if (!libraryId) {
    return <div className={styles.container}>Loading...</div>;
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
      </header>
      <SettingsNav />

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Scan Roots</h2>
        <p className={styles.subtitle}>Manage the folders Liner indexes for music files</p>

        {/* Add form */}
      {!showAddForm ? (
        <button className={styles.addButton} onClick={() => setShowAddForm(true)}>
          + Add Scan Root
        </button>
      ) : (
        <form onSubmit={handleAddRoot} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="path">Path (absolute, inside container)</label>
            <input
              id="path"
              type="text"
              name="path"
              value={formData.path}
              onChange={handleInputChange}
              placeholder="/music"
              disabled={createMutation.isPending}
            />
            {errors.path && <span className={styles.error}>{errors.path}</span>}
          </div>

          <div className={styles.field}>
            <label htmlFor="displayName">Display Name</label>
            <input
              id="displayName"
              type="text"
              name="displayName"
              value={formData.displayName}
              onChange={handleInputChange}
              placeholder="My Music Library"
              disabled={createMutation.isPending}
            />
            {errors.displayName && <span className={styles.error}>{errors.displayName}</span>}
          </div>

          <div className={styles.field}>
            <label>
              <input
                type="checkbox"
                name="writable"
                checked={formData.writable}
                onChange={handleInputChange}
                disabled={createMutation.isPending}
              />
              Writable (allow tag edits)
            </label>
          </div>

          <div className={styles.field}>
            <label htmlFor="pollIntervalS">Poll Interval (seconds)</label>
            <input
              id="pollIntervalS"
              type="number"
              name="pollIntervalS"
              value={formData.pollIntervalS}
              onChange={handleInputChange}
              min="60"
              step="60"
              disabled={createMutation.isPending}
            />
            {errors.pollIntervalS && (
              <span className={styles.error}>{errors.pollIntervalS}</span>
            )}
          </div>

          <div className={styles.formActions}>
            <button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Adding...' : 'Add Root'}
            </button>
            <button type="button" className="secondary" onClick={() => setShowAddForm(false)}>
              Cancel
            </button>
          </div>

          {createMutation.error && (
            <div className={styles.serverError}>
              {(createMutation.error as any)?.detail || 'Failed to add scan root'}
            </div>
          )}
        </form>
      )}

      <p className={styles.helpText}>
        The path must exist on the worker host (where the music is mounted), not on the web app host.
        The worker validates it within a few seconds.
      </p>

      {/* Roots list */}
      {isLoading ? (
        <div className={styles.loading}>Loading scan roots...</div>
      ) : scanRoots.length === 0 ? (
        <div className={styles.emptyState}>
          <p>No scan roots configured yet. Add one to start indexing your library.</p>
        </div>
      ) : (
        <div className={styles.rootsList}>
          {scanRoots.map((root) => (
            <div key={root.id} className={styles.rootCard}>
              <div className={styles.rootHeader}>
                <div className={styles.rootTitleArea}>
                  <h3 className={styles.rootTitle}>{root.displayName}</h3>
                  <p className={styles.rootPath}>{root.path}</p>
                </div>
                <div className={styles.rootMeta}>
                  {root.validationStatus === 'pending' && (
                    <span className={`${styles.badge} ${styles.validationPending}`} title="Waiting for worker validation">
                      Pending validation
                    </span>
                  )}
                  {root.validationStatus === 'ok' && (
                    <span
                      className={`${styles.badge} ${styles.validationOk}`}
                      title={root.probeWritable === false ? 'Mounted read-only' : 'Path validated'}
                    >
                      {root.probeWritable === false ? 'Read-only mount' : 'OK'}
                    </span>
                  )}
                  {root.validationStatus === 'missing' && (
                    <span className={`${styles.badge} ${styles.validationError}`} title={root.validationMessage || 'Path does not exist'}>
                      Missing
                    </span>
                  )}
                  {root.validationStatus === 'not_directory' && (
                    <span className={`${styles.badge} ${styles.validationError}`} title={root.validationMessage || 'Path is not a directory'}>
                      Not a directory
                    </span>
                  )}
                  {root.validationStatus === 'unreadable' && (
                    <span className={`${styles.badge} ${styles.validationError}`} title={root.validationMessage || 'Path is not readable'}>
                      Unreadable
                    </span>
                  )}
                  {root.validatedAt && (
                    <span className={styles.badge} title={new Date(root.validatedAt).toLocaleString()}>
                      {new Date(root.validatedAt).toLocaleDateString()}
                    </span>
                  )}
                  <span className={styles.badge}>{root.writable ? 'Writable' : 'Read-only'}</span>
                  <span className={styles.badge}>{root.enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
              </div>

              <div className={styles.rootStats}>
                <span>{root.albumsFound || 0} albums</span>
                <span>{root.tracksFound || 0} tracks</span>
                {root.lastScanAt && (
                  <span>Last scan: {new Date(root.lastScanAt).toLocaleDateString()}</span>
                )}
              </div>

              <div className={styles.rootActions}>
                <button
                  onClick={() => handleToggleEnabled(root)}
                  className={root.enabled ? 'secondary' : ''}
                  disabled={isPending(root.id)}
                >
                  {isPending(root.id) ? (root.enabled ? 'Disabling...' : 'Enabling...') : (root.enabled ? 'Disable' : 'Enable')}
                </button>
                {root.validationStatus !== 'ok' && (
                  <button
                    onClick={() => handleValidate(root.id)}
                    className="secondary"
                    disabled={isPending(root.id)}
                  >
                    {isPending(root.id) ? 'Checking...' : 'Re-check'}
                  </button>
                )}
                <button
                  onClick={() => handleStartScan(root.id)}
                  className="secondary"
                  disabled={isPending(root.id) || root.lastStatus === 'scanning' || root.validationStatus !== 'ok'}
                  title={root.validationStatus !== 'ok' ? 'Path must be validated first' : ''}
                >
                  {root.lastStatus === 'scanning' || isPending(root.id) ? 'Scanning...' : 'Scan Now'}
                </button>
                <button
                  onClick={() => handleDelete(root.id)}
                  className="secondary"
                  disabled={isPending(root.id)}
                >
                  {isPending(root.id) ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
