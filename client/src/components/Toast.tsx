import './Toast.css';

export function Toast({ message }: { message: string }) {
  return (
    <div className="toast">
      <span className="toast__dot" />
      {message}
    </div>
  );
}
