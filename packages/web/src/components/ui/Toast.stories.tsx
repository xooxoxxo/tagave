import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { dismissToast, showToast, ToastHost, type ToastOptions } from './Toast';
import { Button } from './Button';
import { Row } from '../../stories/fixtures';

function Shown(props: ToastOptions) {
  useEffect(() => {
    const id = showToast({ durationMs: 0, ...props });
    return () => dismissToast(id);
  }, [props]);
  return null;
}

const meta = {
  title: 'Components/Toast',
  component: ToastHost,
  tags: ['shot-viewport'],
  parameters: { layout: 'fullscreen', docs: { story: { inline: false, iframeHeight: 200 }, description: { component: 'A short-lived note at the foot of the screen after an action, with at most one action (Undo). `showToast({ message, action, tone, durationMs })` replaces the one showing; it leaves on its own after durationMs (8 s by default). Screen readers hear it politely (assertively for `tone: "danger"`). For something the person must act on, use a Banner or a ConfirmDialog. `<ToastHost />` is mounted once at the root.' } } },
} satisfies Meta<typeof ToastHost>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Message: Story = { render: () => <Shown message="Listen logged" /> };
export const WithUndo: Story = { render: () => <Shown message="Added to your physical collection" action={{ label: 'Undo', onClick: () => undefined }} /> };
export const Danger: Story = { render: () => <Shown tone="danger" message="Couldn’t save the clipping. Try again." /> };
export const LongMessage: Story = { render: () => <Shown message="Removed 12 tracks from Café del Mar, Volumen Siete (Remastered Deluxe Edition) and moved them to the trash folder" action={{ label: 'Undo', onClick: () => undefined }} /> };
export const FromCode: Story = {
  tags: ['!shot-viewport'],
  render: () => <Row><Button variant="secondary" onClick={() => showToast({ message: 'Listen logged', durationMs: 3000 })}>Show a toast</Button><Button variant="secondary" onClick={() => showToast({ message: 'Couldn’t save', tone: 'danger' })}>Show an error</Button></Row>,
};
