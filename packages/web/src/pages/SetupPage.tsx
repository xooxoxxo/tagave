/**
 * First-run onboarding page (PLT-4)
 * Creates the admin account with email, password, and contact string for provider User-Agent
 */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSetup } from '../hooks/useAuth';
import { SetupRequest } from '@liner/shared';
import styles from './SetupPage.module.css';

export function SetupPage() {
  const navigate = useNavigate();
  const setupMutation = useSetup();

  const [formData, setFormData] = useState({
    email: '',
    password: '',
    displayName: '',
    contactString: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    // Clear error when user starts typing
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: '' }));
    }
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.email) {
      newErrors.email = 'Email is required';
    } else if (!formData.email.includes('@')) {
      newErrors.email = 'Invalid email address';
    }

    if (!formData.password) {
      newErrors.password = 'Password is required';
    } else if (formData.password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters';
    }

    if (!formData.displayName) {
      newErrors.displayName = 'Display name is required';
    }

    if (!formData.contactString) {
      newErrors.contactString = 'Contact string is required';
    } else if (!isValidContactString(formData.contactString)) {
      newErrors.contactString = 'Must be a valid email or URL';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const isValidContactString = (s: string): boolean => {
    // Accept URLs or emails
    if (s.includes('@') && s.includes('.')) return true; // Email-like
    if (s.startsWith('http://') || s.startsWith('https://')) return true; // URL
    return false;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    setupMutation.mutate(formData as SetupRequest, {
      onSuccess: () => {
        navigate({ to: '/' });
      },
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Set up Liner</h1>
        <p className={styles.subtitle}>Create your admin account to get started</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          {/* Email */}
          <div className={styles.field}>
            <label htmlFor="email" className={styles.label}>
              Email
            </label>
            <input
              id="email"
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="you@example.com"
              disabled={setupMutation.isPending}
            />
            {errors.email && <span className={styles.error}>{errors.email}</span>}
          </div>

          {/* Password */}
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
              name="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="At least 8 characters"
              disabled={setupMutation.isPending}
            />
            {errors.password && <span className={styles.error}>{errors.password}</span>}
          </div>

          {/* Display Name */}
          <div className={styles.field}>
            <label htmlFor="displayName" className={styles.label}>
              Display Name
            </label>
            <input
              id="displayName"
              type="text"
              name="displayName"
              value={formData.displayName}
              onChange={handleChange}
              placeholder="Your name"
              disabled={setupMutation.isPending}
            />
            {errors.displayName && <span className={styles.error}>{errors.displayName}</span>}
          </div>

          {/* Contact String */}
          <div className={styles.field}>
            <label htmlFor="contactString" className={styles.label}>
              Contact Information
              <span className={styles.hint}>
                (for provider User-Agent headers – email or website)
              </span>
            </label>
            <input
              id="contactString"
              type="text"
              name="contactString"
              value={formData.contactString}
              onChange={handleChange}
              placeholder="contact@example.com or https://example.com"
              disabled={setupMutation.isPending}
            />
            {errors.contactString && (
              <span className={styles.error}>{errors.contactString}</span>
            )}
          </div>

          {/* Server Error */}
          {setupMutation.error && (
            <div className={styles.serverError}>
              {(setupMutation.error as any)?.detail || 'Setup failed. Please try again.'}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            className={styles.submitBtn}
            disabled={setupMutation.isPending}
          >
            {setupMutation.isPending ? 'Creating account...' : 'Create Account'}
          </button>
        </form>

        <div className={styles.footer}>
          <p>By creating an account, you agree to store and index your music archive locally.</p>
        </div>
      </div>
    </div>
  );
}
