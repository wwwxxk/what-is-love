import type { RoomSnapshot } from "@/features/rooms/lifecycle";

const dimensions = [
  ["WHO", "People"], ["WHAT", "Actions"], ["WHEN", "Moments"],
  ["WHERE", "Places"], ["HOW", "Ways"], ["FEELING", "Emotions"],
];
export function TrainingPreparation({ snapshot }: { snapshot: RoomSnapshot }) {
  return <section className="mx-auto mt-8 max-w-4xl" aria-labelledby="preparation-title">
    <p className="eyebrow">YOUR ROBOT IS WAITING</p>
    <h1 id="preparation-title" className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Training Preparation</h1>
    <p className="mt-4 text-sm text-muted">Room <span className="font-mono text-ink">{snapshot.room.join_code}</span> · You’re here as <strong className="text-ink">{snapshot.participant.nickname}</strong> · {snapshot.participant.role === "organizer" ? "Organizer" : "Participant"}</p>
    <div className="notice mt-6" role="status">Training has started. Your place in this group is saved in this browser.</div>
    <div className="mt-8 max-w-2xl">
      <h2 className="text-2xl font-semibold sm:text-3xl">Six perspectives. One shared understanding of love.</h2>
      <p className="mt-4 leading-relaxed text-muted">Together, you&apos;ll help your robot discover what love means.</p>
    </div>
    <ul className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="The six dimensions">
      {dimensions.map(([name, description]) => <li key={name} className="panel">
        <h3 className="text-sm font-semibold tracking-widest text-accent">{name}</h3>
        <p className="mt-2 text-sm text-muted">{description}</p>
      </li>)}
    </ul>
    <p className="mt-6 leading-relaxed text-muted">Your group will explore these dimensions in the next stage. No dimensions have been assigned yet.</p>
    <section className="panel mt-8" aria-labelledby="preparation-members">
      <h2 id="preparation-members" className="text-lg font-semibold">Your group · {snapshot.members.length} {snapshot.members.length === 1 ? "member" : "members"}</h2>
      <ul className="mt-3 divide-y divide-line">{snapshot.members.map((member) => <li key={member.id} className="flex justify-between gap-4 py-3 text-sm">
        <span className="min-w-0 break-words">{member.nickname}{member.id === snapshot.participant.id && <span className="ml-2 text-muted">You</span>}</span>
        <span className="shrink-0 text-muted">{member.role === "organizer" ? "Organizer" : "Participant"}</span>
      </li>)}</ul>
    </section>
  </section>;
}
