import { FolderOpen, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatSize, PAGE_PRESETS } from '../document/presets';
import { platformKind } from '../platform/files';
import { newProject, openProjectFromPicker, openRecentProject } from '../state/actions';
import { showToast } from '../state/store';
import { deleteProject, listProjects, type ProjectSummary } from '../storage/projectsDb';
import { Button, IconButton } from './controls';

function Thumbnail({ bytes, alt }: { bytes: Uint8Array | null; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) return;
    // A short-lived URL purely to display the preview; it is released when the card goes away.
    const objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes]);
  return url ? (
    <img src={url} alt={alt} className="h-full w-full object-contain" draggable={false} />
  ) : (
    <span className="text-[12px] text-faint">No preview</span>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The first screen: start something new, open a file, or pick up where you left off. */
export function StartScreen() {
  const [recents, setRecents] = useState<ProjectSummary[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const where = platformKind() === 'desktop' ? 'on this computer' : 'in this browser';

  const refresh = () =>
    listProjects()
      .then(setRecents)
      .catch(() => setRecents([]));

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="scroll-quiet h-full overflow-y-auto" data-testid="start-screen">
      <div className="mx-auto flex max-w-4xl flex-col gap-10 px-8 py-14">
        <header>
          <h1 className="text-[28px] font-semibold tracking-tight text-ink">What would you like to make?</h1>
          <p className="mt-1 text-[14px] text-dim">Pick a size to start. You can change it at any time.</p>
        </header>

        <section aria-label="New design">
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {PAGE_PRESETS.map((preset) => (
              <li key={preset.id}>
                <button
                  type="button"
                  onClick={() => newProject(preset)}
                  data-testid={`new-${preset.id}`}
                  className="group flex w-full flex-col gap-3 rounded-xl bg-panel p-4 text-left transition-colors hover:bg-raised"
                >
                  <span className="flex h-24 items-center justify-center">
                    <span
                      className="rounded bg-ink/90 shadow-pop transition-transform group-hover:scale-[1.03]"
                      style={{ width: 112, aspectRatio: `${preset.width} / ${preset.height}`, maxHeight: 88 }}
                      aria-hidden
                    />
                  </span>
                  <span>
                    <span className="block font-medium text-ink">{preset.label}</span>
                    <span className="block text-[12px] tabular-nums text-dim">{formatSize(preset.width, preset.height)} px</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <Button icon={<FolderOpen size={16} />} onClick={() => void openProjectFromPicker()} className="h-9" data-testid="open-project">
              Open a project file
            </Button>
          </div>
        </section>

        <section aria-label="Recent designs">
          <h2 className="text-[15px] font-semibold text-ink">Recent designs</h2>
          <p className="mt-0.5 text-[12px] text-dim">
            These are kept automatically {where}. To keep a design safe or move it to another computer, open it and choose Save.
          </p>
          {recents === null ? null : recents.length === 0 ? (
            <p className="mt-4 text-dim">Designs you work on will appear here.</p>
          ) : (
            <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="recents">
              {recents.map((project) => (
                <li key={project.id} className="group relative rounded-xl bg-panel">
                  <button
                    type="button"
                    onClick={() => void openRecentProject(project.id)}
                    className="flex w-full flex-col rounded-xl text-left transition-colors hover:bg-raised"
                    data-testid="recent-project"
                  >
                    <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-t-xl bg-app">
                      <Thumbnail bytes={project.thumbnail} alt="" />
                    </span>
                    <span className="block px-3 py-2.5">
                      <span className="block truncate font-medium text-ink">{project.name}</span>
                      <span className="block text-[12px] text-dim">
                        {formatSize(project.width, project.height)} · {formatWhen(project.updatedAt)}
                      </span>
                      {project.hasUnsavedFileChanges && (
                        <span className="mt-1 inline-block rounded bg-warn/15 px-1.5 py-0.5 text-[11px] text-warn">
                          {project.savedToFileAt ? 'Has changes not yet saved to its file' : 'Not saved to a file yet'}
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="absolute right-2 top-2">
                    {confirming === project.id ? (
                      <span className="flex items-center gap-1 rounded-md bg-raised p-1 shadow-pop">
                        <span className="px-1 text-[12px] text-ink">Remove this copy?</span>
                        <Button
                          className="h-7"
                          onClick={() =>
                            void deleteProject(project.id)
                              .then(refresh)
                              .catch(() => showToast('error', 'That design could not be removed.'))
                              .finally(() => setConfirming(null))
                          }
                        >
                          Remove
                        </Button>
                        <Button variant="ghost" className="h-7" onClick={() => setConfirming(null)}>
                          Keep
                        </Button>
                      </span>
                    ) : (
                      <IconButton
                        label={`Remove ${project.name} from recent designs`}
                        className="bg-raised opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => setConfirming(project.id)}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
