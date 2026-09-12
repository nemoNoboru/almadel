import type { JSX } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import rehypeSanitize from "rehype-sanitize"
import { cn } from "cn"

type CodeProps = JSX.IntrinsicElements["code"] & {
  node?: { position?: { start: { line: number }; end: { line: number } } }
}

function Code({ node, className, children, ...props }: CodeProps) {
  const isBlock = node?.position != null && node.position.start.line !== node.position.end.line
  return (
    <code
      className={cn(isBlock ? undefined : "rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]", className)}
      {...props}
    >
      {children}
    </code>
  )
}

const components: Components = {
  p: ({ node: _node, ...props }) => <p className="leading-relaxed" {...props} />,
  h1: ({ node: _node, ...props }) => <h1 className="mt-3 mb-1 text-lg font-semibold first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mt-3 mb-1 text-base font-semibold first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className="mt-2 mb-1 text-sm font-medium first:mt-0" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className="mt-2 mb-1 text-sm font-medium first:mt-0" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-1 list-disc space-y-0.5 pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-1 list-decimal space-y-0.5 pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="leading-relaxed" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a className="underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-1 border-l-2 border-foreground/25 pl-3 text-muted-foreground" {...props} />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-2 border-foreground/15" {...props} />,
  code: Code,
  pre: ({ node: _node, ...props }) => (
    <pre
      className="my-1.5 overflow-x-auto rounded-md bg-foreground/10 p-2.5 font-mono text-xs whitespace-pre-wrap break-words"
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className="border border-foreground/15 px-2 py-1 text-left font-semibold" {...props} />
  ),
  td: ({ node: _node, ...props }) => <td className="border border-foreground/15 px-2 py-1" {...props} />,
}

export function Markdown({ children }: { children: string | null | undefined }) {
  return (
    <div className="text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {children ?? ""}
      </ReactMarkdown>
    </div>
  )
}
