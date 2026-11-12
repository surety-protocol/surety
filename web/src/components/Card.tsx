import { clsx } from 'clsx';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  hover?: boolean;
}

export function Card({ children, className, padding = 'md', hover = false, ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        'bg-white rounded-xl border border-slate-200/80 shadow-sm',
        padding === 'none' && 'p-0',
        padding === 'sm'  && 'p-4',
        padding === 'md'  && 'p-5',
        padding === 'lg'  && 'p-6',
        hover && 'card-hover cursor-pointer',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('mb-4 flex items-center justify-between gap-3', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={clsx('text-sm font-semibold text-slate-900 tracking-tight', className)}>
      {children}
    </h2>
  );
}

export function CardDescription({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-slate-500 mt-0.5">{children}</p>;
}
