const sources = {
  gmail: new URL("../assets/services/gmail.svg", import.meta.url).href,
  calendar: new URL("../assets/services/calendar.svg", import.meta.url).href,
  telegram: new URL("../assets/services/telegram.svg", import.meta.url).href,
};

export function ServiceIcon({ service }: { service: keyof typeof sources }) {
  return (
    <img
      src={sources[service]}
      alt=""
      aria-hidden="true"
      width={18}
      height={18}
      className="size-4.5 shrink-0 object-contain"
      draggable={false}
    />
  );
}
