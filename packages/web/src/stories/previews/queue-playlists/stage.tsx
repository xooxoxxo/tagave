/** Shared story plumbing: the desktop bar with fixture props, and the story parameters. */
import { PlayerBarView } from '../../../components/PlayerBar';
import { albumById, queue } from './fixtures';

const noop = () => undefined;

export function DesktopBar({ queueOpen = false }: { queueOpen?: boolean }) {
  const t = queue.current;
  const a = albumById(t.albumId);
  return (
    <PlayerBarView
      title={t.title}
      artist={t.artist}
      album={a.title}
      artists={[{ id: 'chet-baker', name: 'Chet Baker' }]}
      albumId={a.id}
      coverUrl={a.cover}
      status="playing"
      position={queue.position}
      duration={t.sec}
      volume={0.8}
      canPrevious
      canNext
      onToggle={noop}
      onPrevious={noop}
      onNext={noop}
      onSeek={noop}
      onVolume={noop}
      onRetry={noop}
      onClose={noop}
      queueOpen={queueOpen}
      onQueue={noop}
    />
  );
}

export const previewParams = {
  layout: 'fullscreen' as const,
  // previews for a design round: no baselines, and the a11y scan is not the point here
  a11y: { test: 'off' as const },
};
