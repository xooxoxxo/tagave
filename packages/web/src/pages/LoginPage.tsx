/**
 * Login page (PLT-1)
 */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLogin } from '../hooks/useAuth';
import { LoginRequest } from '@liner/shared';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const navigate = useNavigate();
  const loginMutation = useLogin();

  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [showPassword, setShowPassword] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    loginMutation.mutate(formData as LoginRequest, {
      onSuccess: () => {
        navigate({ to: '/' });
      },
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>tagave</h1>
        <p className={styles.subtitle}>Sign in to your music archive</p>

        <form onSubmit={handleSubmit} className={styles.form}>
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
              placeholder="your@example.com"
              disabled={loginMutation.isPending}
              autoComplete="email"
            />
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
              name="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Enter your password"
              disabled={loginMutation.isPending}
              autoComplete="current-password"
            />
          </div>

          {loginMutation.error && (
            <div className={styles.serverError}>
              {(loginMutation.error as any)?.detail || 'Login failed. Please check your credentials.'}
            </div>
          )}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={loginMutation.isPending || !formData.email || !formData.password}
          >
            {loginMutation.isPending ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className={styles.footer}>
          <p>
            First time here? <a href="/setup">Create the owner account</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
