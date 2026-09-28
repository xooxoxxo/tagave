import { SETUP_STEPS, stepNumber, type SetupStep } from '../pages/setupWizard';
import styles from './SetupSteps.module.css';

/** Where the owner is in first-run setup, across /setup and /onboarding. */
export function SetupSteps({ current }: { current: SetupStep }) {
  const n = stepNumber(current);
  return (
    <nav aria-label="Setup progress" className={styles.wrap}>
      <p className={styles.count}>
        Step {n} of {SETUP_STEPS.length}
      </p>
      <ol className={styles.steps}>
        {SETUP_STEPS.map((step, i) => {
          const state = i + 1 < n ? styles.done : i + 1 === n ? styles.current : styles.todo;
          return (
            <li key={step} className={state} aria-current={i + 1 === n ? 'step' : undefined}>
              <span className={styles.dot} aria-hidden="true">{i + 1 < n ? '✓' : i + 1}</span>
              <span>{step}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
