import { useScreenshots } from "../../lib/hooks";
import { timeAgo } from "../../lib/utils";

export function ScreenshotsPanel() {
  const shots = useScreenshots();

  if (shots.length === 0) {
    return <p className="text-sm opacity-60">No screenshots captured yet.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {shots.map((shot) => (
        <figure
          key={shot.id}
          className="overflow-hidden rounded-box border border-base-300 bg-base-200"
        >
          <button
            type="button"
            className="block w-full"
            onClick={() => window.open(shot.dataUrl, "_blank")}
            title="Open full size"
          >
            <img
              src={shot.dataUrl}
              alt={`${shot.group} capture`}
              className="aspect-video w-full object-cover object-top"
            />
          </button>
          <figcaption className="flex items-center justify-between px-3 py-2 text-xs opacity-70">
            <code className="truncate">{shot.group}</code>
            <span>{timeAgo(shot.ts)}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
