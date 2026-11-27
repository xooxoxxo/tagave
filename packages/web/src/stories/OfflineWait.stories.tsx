import type { Meta, StoryObj } from '@storybook/react-vite';
import { PAUSED_OFFLINE_STAGE, type MaintenanceTaskView } from '@tagave/shared';
import { MaintenanceTaskStatusView } from '../components/MaintenanceTaskStatus';
import { PlanStatusBadge } from '../components/PlanStatusBadge';
import { MoveError } from '../pages/MovedPage';
import { planStatusView } from '../utils/planStatus';
import moved from '../pages/DeletingPage.module.css';

const noop = () => undefined;

const PAUSED: MaintenanceTaskView = {
  id: '00000000-0000-4000-8000-000000000001', kind: 'split', subjectId: null, state: 'interrupted',
  stage: PAUSED_OFFLINE_STAGE, progress: { done: 3, total: 11 }, error: null, attempt: 1,
  updatedAt: '2026-11-24T14:02:00.000Z', cancelRequested: false, workerAvailable: true, actions: ['continue'],
  waitsForFolder: true,
};

const task = (t: MaintenanceTaskView) => <MaintenanceTaskStatusView task={t} pending={false} failed={false} onAction={noop} />;
const plans = () => (
  <div style={{ display: 'grid', gap: 16, justifyItems: 'start' }}>
    <PlanStatusBadge view={planStatusView('waiting')} />
    <PlanStatusBadge view={planStatusView('paused', null, PAUSED_OFFLINE_STAGE)} />
  </div>
);
// a row of Library care › Moved: the move the offline folder cut off, quiet and with no "?" (Undo is its action)
const movedRow = () => (
  <ul className={moved.list}>
    <li className={moved.row}>
      <div className={moved.body}>
        <p className={moved.title}><span className={moved.album}>Funeral</span></p>
        <p className={moved.meta}>
          <span>Arcade Fire</span>
          <span>4 songs</span>
          <span>24 Nov</span>
          <MoveError error={PAUSED_OFFLINE_STAGE} />
        </p>
      </div>
    </li>
  </ul>
);

const meta = {
  title: 'Library care/Offline wait',
  component: MaintenanceTaskStatusView,
  args: { task: PAUSED, pending: false, failed: false, onAction: noop },
  decorators: [(Story) => <div style={{ padding: '24px 16px', maxWidth: 640 }}><Story /></div>],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Work the offline music folder holds. A split paused while the folder is offline says so, its help behind "?", and Continue stays off until the folder is back (the API refuses it too). A tag plan waiting for the folder, or paused by a split it cut off, keeps its help behind the "?" next to its status. A move cut off reads as paused in Library care › Moved, in the quiet tone and with no "?": Undo stays its only action.',
      },
    },
  },
} satisfies Meta<typeof MaintenanceTaskStatusView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The folder is still away: Continue is off. */
export const SplitPaused: Story = { name: 'Split paused, folder offline', render: () => task(PAUSED) };
export const PhoneSplitPaused: Story = { name: 'Phone, split paused, folder offline', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => task(PAUSED) };
/** The folder is back: Continue goes. */
export const SplitFolderBack: Story = { name: 'Split paused, folder back', render: () => task({ ...PAUSED, waitsForFolder: false }) };
export const PhoneSplitFolderBack: Story = { name: 'Phone, split paused, folder back', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: () => task({ ...PAUSED, waitsForFolder: false }) };
/** A plan waiting for its music folder, and one paused by a split the folder cut off. */
export const PlanStatus: Story = { name: 'Tag plan status', render: plans };
export const PhonePlanStatus: Story = { name: 'Phone, tag plan status', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: plans };
export const MovePaused: Story = { name: 'Move paused', render: movedRow };
export const PhoneMovePaused: Story = { name: 'Phone, move paused', tags: ['phone'], globals: { viewport: { value: 'phone' } }, render: movedRow };
