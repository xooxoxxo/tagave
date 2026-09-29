import { useState } from 'react';
import { Button, IconButton } from './Button';
import { TextField, Select, Textarea, SearchField } from './FormControl';
import { Tabs } from './Tabs';
import { Badge } from './Badge';
import { Banner } from './Banner';
import { confirmDialog } from './ConfirmDialog';
import { Card, StatCard, Surface } from './Card';
import { Chip } from './Chip';
import { Table, Th, Td } from './Table';
import { EmptyState } from './EmptyState';
import { Tooltip } from './Tooltip';
import { ThemeSwitch } from './SegmentedControl';
import { UndoIcon } from './icons';
import styles from './DesignSystemCatalog.module.css';

const swatches = ['canvas', 'surface', 'mist', 'line', 'ink', 'ink-2', 'ink-3', 'dew-tint', 'dew-hi', 'dew', 'dew-lo', 'danger'];
const PlayIcon = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>;
const EditIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>;
const RevertIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.2-5.1M5 4v3.5h3.5" /></svg>;

/** Development-only HTML entry renders real components without auth or API fixtures. */
export function DesignSystemCatalog() {
  const [tab, setTab] = useState('controls');
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<string[]>(['Needs review']);
  const toggle = (value: string) => setFilters(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value]);
  return <main className={styles.catalog}>
    <header className={styles.header}>
      <span className={styles.eyebrow}>Design system</span>
      <h1 className={styles.display}>Your library, <em>quietly</em> in order.</h1>
      <p className={styles.lede}>Porcelain and dew: a quiet stage, and tactile drops for everything you can press.</p>
      <div className={styles.row}><ThemeSwitch /></div>
    </header>

    <section className={styles.section} aria-labelledby="foundations">
      <h2 id="foundations">Foundations</h2>
      <div className={styles.swatches}>{swatches.map(token => <div key={token} className={styles.swatch}><span style={{ background: `var(--${token})` }} /><code>{token}</code></div>)}</div>
      <div className={styles.typeScale}>
        <p className={styles.headline}>Compilations, gathered</p>
        <p className={styles.title}>Various Artists — Café del Mar</p>
        <p>Twelve tracks share one folder but carry four different album-artist tags. Set them together, preview the plan, then apply.</p>
        <p className={styles.eyebrow}>Album artist</p>
        <code>ALBUMARTIST=Various Artists</code>
      </div>
    </section>

    <Tabs label="Component examples" panelId="catalog-panel" items={[{ value: 'controls', label: 'Controls' }, { value: 'data', label: 'Data display', count: 3 }, { value: 'feedback', label: 'Feedback' }]} value={tab} onChange={setTab} />
    <div id="catalog-panel" role="tabpanel" aria-label={`${tab} examples`} className={styles.section}>
      {tab === 'controls' && <>
        <section>
          <h2>Buttons</h2>
          <div className={styles.row}><Button>Apply plan</Button><Button variant="secondary">Preview</Button><Button variant="quiet">Cancel</Button><Button variant="secondary"><UndoIcon />Revert</Button><Button variant="quiet-danger">Delete</Button></div>
          <div className={styles.row}><Button disabled>Apply plan</Button><Button variant="secondary" disabled>Preview</Button><Button variant="quiet" disabled>Cancel</Button><Button variant="secondary" disabled><UndoIcon />Revert</Button><Button variant="quiet-danger" disabled>Delete</Button></div>
          <div className={styles.row}><Button size="sm">Fix folder tags</Button><Button size="sm" variant="secondary">Details</Button><Button size="sm" variant="quiet">Skip</Button><Button size="sm" variant="quiet-danger">Discard</Button><Button size="sm" variant="danger">Delete (dialog only)</Button></div>
          <div className={styles.row}>
            <IconButton label="Play" variant="primary"><PlayIcon /></IconButton>
            <IconButton label="Edit tags"><EditIcon /></IconButton>
            <IconButton label="Revert file" variant="quiet"><RevertIcon /></IconButton>
            <IconButton label="Play" variant="primary" size="sm"><PlayIcon /></IconButton>
            <IconButton label="Edit tags" size="sm"><EditIcon /></IconButton>
            <IconButton label="Play" variant="primary" disabled><PlayIcon /></IconButton>
          </div>
          <div className={styles.row}><Button loading={busy} onClick={() => setBusy(true)}>{busy ? 'Saving example…' : 'Try loading state'}</Button><Button variant="quiet" onClick={() => setBusy(false)}>Reset example</Button></div>
          <p className={styles.note}>One primary drop per view. Buttons default to type="button"; use type="submit" for forms. Loading keeps the width and colour and blocks repeat presses.</p>
        </section>
        <section>
          <h2>Fields</h2>
          <SearchField label="Search the library" placeholder="Albums, artists, folders" />
          <form className={styles.form} onSubmit={event => { event.preventDefault(); setSubmitted(true); }} noValidate>
            <TextField label="Library name" required value={name} hint="A name that helps you recognize this library." error={submitted && !name.trim() ? 'Enter a library name.' : undefined} onChange={event => { setName(event.target.value); setSubmitted(false); }} />
            <TextField label="Album artist" defaultValue="Various Artists" previousValue="DJ Example" />
            <TextField label="Disabled field" value="Read-only example" disabled />
            <label className={styles.label}>Default view<Select defaultValue="grid"><option value="grid">Album grid</option><option value="list">Album list</option></Select></label>
            <label className={styles.label}>Notes<Textarea placeholder="Add a note about your library" /></label>
            <Button type="submit">Validate example</Button>{submitted && name.trim() && <p role="status">Example is valid. Nothing was sent to a server.</p>}
          </form>
        </section>
        <section>
          <h2>Chips and tooltips</h2>
          <div className={styles.row}>{['Needs review', 'Compilations', 'Missing cover', 'Lossless', 'Added this week'].map(value => <Chip key={value} active={filters.includes(value)} dot={value === 'Needs review' ? true : undefined} onClick={() => toggle(value)}>{value}</Chip>)}</div>
          <div className={styles.row}><Chip dot="ok">Matched</Chip><Chip dot="warn">4 artist tags</Chip><Chip dot="danger">Unreadable</Chip><Chip>FLAC</Chip></div>
          <div className={styles.row}><Tooltip content="Restores every file in this plan to its journalled tags."><Button variant="secondary">Hover or focus me</Button></Tooltip><Tooltip content="Below the trigger" side="bottom"><IconButton label="Edit"><EditIcon /></IconButton></Tooltip></div>
        </section>
      </>}
      {tab === 'data' && <>
        <section><h2>Status labels</h2><div className={styles.row}><Badge>Draft</Badge><Badge tone="success">Applied</Badge><Badge tone="warning">Needs review</Badge><Badge tone="danger">Failed</Badge><Badge tone="info">Processing</Badge><Badge tone="accent">Compilation</Badge></div><p className={styles.note}>Status is always written in text; colour is a dot. Badges are not buttons or navigation.</p></section>
        <div className={styles.stats}><StatCard label="Albums" value="1,284" hint="12 added this week" /><StatCard label="Need review" value="37" tone="warning" /><StatCard label="Applied plans" value="212" tone="success" /></div>
        <section><h2>Tables</h2><Card padded={false}><Table><thead><tr><Th>Album</Th><Th>Artist</Th><Th>Status</Th></tr></thead><tbody><tr><Td>Café del Mar, Vol. 7</Td><Td>Various Artists</Td><Td><Badge tone="success">Matched</Badge></Td></tr><tr><Td>Unidentified album</Td><Td>Unknown artist</Td><Td><Badge tone="warning">Needs review</Badge></Td></tr></tbody></Table></Card></section>
        <Card title="Grouped content" actions={<Button size="sm" variant="secondary">Edit</Button>}><p>A card groups related information. Use page spacing and headings when a separate surface is unnecessary.</p></Card>
        <Surface variant="glass" className={styles.glassDemo}><span>Plan ready: 14 files, 28 changes</span><Button size="sm">Apply plan</Button></Surface>
      </>}
      {tab === 'feedback' && <><h2>Messages</h2><Banner tone="success">Changes saved.</Banner><Banner tone="warning">Some files need review before changes can be applied.</Banner><Banner tone="danger">Couldn’t load this library. Try again.</Banner><Banner tone="info">Identification is running. Results appear as albums are processed.</Banner><EmptyState title="No albums match" text="Clear a filter or search for another artist." action={<Button variant="secondary">Clear filters</Button>} /><h2>Confirm dialog</h2><div className={styles.row}><Button variant="secondary" onClick={() => void confirmDialog({ title: 'Apply this tag plan?', message: 'Every write is journaled and can be reverted.', confirmLabel: 'Apply changes' })}>Ask to apply</Button><Button variant="secondary" onClick={() => void confirmDialog({ title: 'Delete this saved view?', message: 'The albums are not affected, only the saved filters.', confirmLabel: 'Delete', tone: 'danger' })}>Ask to delete</Button></div></>}
    </div><footer className={styles.note}>Development catalog. See DESIGN.md for component contracts and migration rules.</footer>
  </main>;
}
