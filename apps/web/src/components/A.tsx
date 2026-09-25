/** Design links: `route('Discover')` maps design page names to app paths; <A> uses the router for internal paths. */
import type { AnchorHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';

const ROUTES: Record<string, string> = {
  Main: '/', Home: '/', Discover: '/discover', Leaderboard: '/leaderboard', Creator: '/creator', Launch: '/launch', Docs: '/docs',
};

export function route(name: string): string {
  return ROUTES[name] ?? '/';
}

export function A({ href = '#', children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href.startsWith('/')) return <Link to={href} {...rest}>{children}</Link>;
  const external = /^https?:/.test(href);
  return <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} {...rest}>{children}</a>;
}
