/**
 * Settings page for scan roots management (LIB-1)
 * Add, edit, enable/disable scan roots
 */

import { useState } from 'react';
import { useCurrentLibrary, useScanRoots, useCreateScanRoot, useUpdateScanRoot, useDeleteScanRoot, useStartScan } from '../hooks';
import { SettingsNav } from '../components/SettingsNav';
import { ScanRoot } from '@liner/shared';
import styles from './SettingsScanRootsPage.module.css';

export function SettingsScanRootsPage() {
  const { libraryId } = useCurrentLibrary();
  const { data: scanRoots = [], isLoading } = useScanRoots(libraryId);
  const createMutation = useCreateScanRoot(libraryId);
  const updateMutation = useUpdateScanRoot(libraryId, undefined);
  const deleteMutation = useDeleteScanRoot(libraryId, undefined);
  const startScanMutation = useStartScan(libraryId, undefined);

  const [showAddForm, setShowAddForm] = useState(false);
  const [formData, setFormData] = useState({
    path: '',
    displayName: '',
    writable: true,
    pollIntervalS: 21600, // 6 hours
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

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

  const handleToggleEnabled = (root: ScanRoot) => {
    updateMutation.mutate({ enabled: !root.enabled });
  };

  const handleDelete = (rootId: string) => {
    if (confirm('Delete this scan root? Files will not be removed.')) {
      deleteMutation.mutate();
    }
  };

  const handleStartScan = (rootId: string) => {
    startScanMutation.mutate();
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
                  disabled={updateMutation.isPending}
                >
                  {root.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={() => handleStartScan(root.id)}
                  className="secondary"
                  disabled={startScanMutation.isPending || root.lastStatus === 'scanning'}
                >
                  {root.lastStatus === 'scanning' ? 'Scanning...' : 'Scan Now'}
                </button>
                <button
                  onClick={() => handleDelete(root.id)}
                  className="secondary"
                  disabled={deleteMutation.isPending}
                >
                  Delete
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
