/**
 * U24: enlace a navegador externo (espejo de ExternalLink.jsx de la Suite).
 * En Tauri la webview no abre <a target="_blank"> (no hay shell por defecto):
 * se intercepta el click y se usa shell.open. En modo Tauri NO se pone
 * target="_blank": en WebView2 el preventDefault del click no suprime la
 * apertura de nueva ventana, y eso abría DOS pestañas por click. Fuera de
 * Tauri (dev) se comporta como un <a> normal.
 */
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { isTauri, openExternal } from '../tauri'

interface Props extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'children'> {
  href: string
  children: ReactNode
}

export default function ExternalLink({ href, children, ...rest }: Props) {
  const tauri = isTauri()
  return (
    <a
      href={href}
      target={tauri ? undefined : '_blank'}
      rel={tauri ? undefined : 'noopener noreferrer'}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (tauri) {
          e.preventDefault()
          void openExternal(href)
        }
      }}
      {...rest}
    >
      {children}
    </a>
  )
}
