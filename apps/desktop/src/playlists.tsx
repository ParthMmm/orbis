import { useEffect, useState, type FormEvent } from "react";
import type { Playlist, SavedSet } from "@orbis/contracts";
import "./api";

export function Playlists({
	selected,
	onSelect,
	revision,
	onUpdated,
}: {
	selected: string;
	onSelect: (id: string) => void;
	revision: number;
	onUpdated: () => void;
}) {
	const [playlists, setPlaylists] = useState<Playlist[]>([]);
	const [members, setMembers] = useState<SavedSet[]>([]);
	const [library, setLibrary] = useState<SavedSet[]>([]);
	const [name, setName] = useState("");
	const [setId, setSetId] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError("");
		setSetId("");
		void Promise.all([
			window.orbis.playlists(),
			window.orbis.list({}),
			window.orbis.list(selected ? { playlistId: selected } : {}),
		]).then(([lists, all, items]) => {
			if (!active) return;
			setLoading(false);
			if (!lists.ok) {
				setError(lists.message);
				return;
			}
			if (!all.ok) {
				setError(all.message);
				return;
			}
			if (!items.ok) {
				setError(items.message);
				return;
			}
			setPlaylists(lists.data.playlists);
			setLibrary(all.data.sets);
			setMembers(selected ? items.data.sets : []);
		});
		return () => {
			active = false;
		};
	}, [selected, revision]);
	async function create(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError("");
		const result = await window.orbis.createPlaylist(name);
		setBusy(false);
		if (!result.ok) {
			setError(result.message);
			return;
		}
		setName("");
		setPlaylists([...playlists, result.data]);
		onSelect(result.data.id);
		onUpdated();
	}
	async function replace(ids: string[]) {
		setBusy(true);
		setError("");
		const result = await window.orbis.setPlaylistMembers(selected, ids);
		setBusy(false);
		if (!result.ok) {
			setError(result.message);
			return;
		}
		setMembers(result.data.sets);
		setSetId("");
		onUpdated();
	}
	function move(index: number, direction: -1 | 1) {
		const ids = members.map((set) => set.id);
		const next = index + direction;
		if (next < 0 || next >= ids.length) return;
		[ids[index], ids[next]] = [ids[next]!, ids[index]!];
		void replace(ids);
	}
	return (
		<section className="playlist-panel" aria-labelledby="playlists-heading">
			<h2 id="playlists-heading">Playlists</h2>
			<label htmlFor="playlist">View</label>
			<select
				id="playlist"
				disabled={busy}
				value={selected}
				onChange={(event) => onSelect(event.target.value)}
			>
				<option value="">All sets</option>
				{playlists.map((playlist) => (
					<option key={playlist.id} value={playlist.id}>
						{playlist.name}
					</option>
				))}
			</select>
			<form onSubmit={create} className="playlist-create">
				<fieldset disabled={busy}>
					<label htmlFor="playlist-name">New playlist</label>
					<div className="input-row">
						<input
							id="playlist-name"
							value={name}
							required
							maxLength={100}
							onChange={(event) => setName(event.target.value)}
							placeholder="Evenings"
						/>
						<button type="submit">Create</button>
					</div>
				</fieldset>
			</form>
			{selected && (
				<details open>
					<summary>Manage playlist</summary>
					<p className="hint">
						Ordered sets, not individual tracks. Removing a set here keeps it in
						your library.
					</p>
					<fieldset disabled={busy || loading || Boolean(error)}>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								if (setId)
									void replace([...members.map((set) => set.id), setId]);
							}}
						>
							<label htmlFor="playlist-set">Add a saved set</label>
							<select
								id="playlist-set"
								required
								value={setId}
								onChange={(event) => setSetId(event.target.value)}
							>
								<option value="">Choose a set</option>
								{library
									.filter(
										(set) => !members.some((member) => member.id === set.id)
									)
									.map((set) => (
										<option key={set.id} value={set.id}>
											{set.title}
										</option>
									))}
							</select>
							<button type="submit" disabled={!setId || members.length >= 500}>
								Add to playlist
							</button>
						</form>
						<ol className="playlist-members">
							{members.map((set, index) => (
								<li key={set.id}>
									<span>{set.title}</span>
									<div className="member-actions">
										<button
											type="button"
											aria-label={`Move ${set.title} up`}
											disabled={index === 0}
											onClick={() => move(index, -1)}
										>
											↑
										</button>
										<button
											type="button"
											aria-label={`Move ${set.title} down`}
											disabled={index === members.length - 1}
											onClick={() => move(index, 1)}
										>
											↓
										</button>
										<button
											type="button"
											aria-label={`Remove ${set.title} from playlist`}
											onClick={() =>
												void replace(
													members
														.filter((member) => member.id !== set.id)
														.map((member) => member.id)
												)
											}
										>
											Remove
										</button>
									</div>
								</li>
							))}
						</ol>
					</fieldset>
				</details>
			)}
			{error && (
				<p role="alert" className="error">
					{error}{" "}
					<button type="button" onClick={onUpdated}>
						Retry
					</button>
				</p>
			)}
			<p role="status" className="hint">
				{busy
					? "Saving playlist…"
					: loading
						? "Loading playlists…"
						: selected
							? `${members.length} sets in playlist`
							: "A set can belong to more than one playlist."}
			</p>
		</section>
	);
}
