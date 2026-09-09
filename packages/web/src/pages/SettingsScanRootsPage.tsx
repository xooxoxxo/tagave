/**
 * Settings page for scan roots management (LIB-1)
 * Add, edit, enable/disable scan roots
 */

import { useState } from 'react';
import { useCurrentLibrary, useScanRoots, useCreateScanRoot, useUpdateScanRoot, useDeleteScanRoot, useStartScan, useValidateScanRoot } from '../hooks';
import { ScanRoot } from '@liner/shared';
import styles from './SettingsScanRootsPage.module.css';

/**
 * Content component for embedding in SettingsPage
 */
export function SettingsScanRootsContent() {
  return <SettingsScanRootsContentInner />;
}

/**
 * Full page component (for backward compatibility / direct navigation)
 */
export function SettingsScanRootsPage() {
  return <SettingsScanRootsContentInner />;
}

function SettingsScanRootsContentInner() {
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

  // Tag writes need both the owner's intent (writable) and the worker's probe
  // (probeWritable); the toggle only turns writes on for a validated,
  // probed-writable root. Turning them off is always allowed.
  const canEnableWrites = (root: ScanRoot) => root.validationStatus === 'ok' && root.probeWritable !== false;

  const writableHint = (root: ScanRoot): string => {
    if (root.writable) return 'Stop tag plans from writing files under this root';
    if (root.validationStatus !== 'ok') return 'The path must be validated by the worker first';
    if (root.probeWritable === false) return 'The worker reports this mount as read-only — remount it read-write and re-check';
    return 'Allow tag plans to write files under this root (writes are journaled and revertible)';
  };

  const handleToggleWritable = (root: ScanRoot) => {
    if (!root.writable && !window.confirm(`Allow tag writes under ${root.path}? Writes are journaled and revertible; nothing changes until you apply a tag plan.`)) return;
    withPending(root.id, () => {
      updateMutation.mutate({ rootId: root.id, data: { writable: !root.writable } }, { onSettled: clearPending(root.id) });
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
    <div className={styles.content}>
        <h2 className={styles.sectionTitle}>Music folders</h2>
        <p className={styles.subtitle}>Manage the folders tagave indexes for music files</p>

        {/* Add form */}
      {!showAddForm ? (
        <button className={styles.addButton} onClick={() => setShowAddForm(true)}>
          + Add music folder
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
          <p>No music folders yet. Add a folder to start building your library.</p>
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
                  onClick={() => handleToggleWritable(root)}
                  className="secondary"
                  disabled={isPending(root.id) || (!root.writable && !canEnableWrites(root))}
                  title={writableHint(root)}
                >
                  {isPending(root.id) ? 'Saving...' : root.writable ? 'Make read-only' : 'Allow tag writes'}
                </button>
                <button
                  onClick={() => handleDelete(root.id)}
                  className="secondary"
                  disabled={isPending(root.id)}
                >
                  {isPending(root.id) ? 'Deleting...' : 'Delete'}
                </button>
              </div>
              {root.writable && root.probeWritable === false && (
                <p className={styles.rootWarning}>
                  Marked writable, but the worker cannot write to this mount — tag plans will not apply here until it is remounted read-write.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
