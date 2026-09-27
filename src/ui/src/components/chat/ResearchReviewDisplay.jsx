import { Bot, ExternalLink, FileText, MessageSquare, Route } from 'lucide-react'

import {
  getResearchAnswer,
  getResearchQuestion,
  getResearchRoute,
  normalizeResearchPapers,
} from './researchHitlUtils'

export default function ResearchReviewDisplay({ data }) {
  const question = getResearchQuestion(data)
  const answer = getResearchAnswer(data)
  const route = getResearchRoute(data)
  const papers = normalizeResearchPapers(data)
  const hasAnswerContent = Boolean(answer || papers.length > 0)

  return (
    <div className="space-y-4">
      {question && (
        <section className="rounded-lg border border-slate-700 bg-slate-900/70 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-100">
            <MessageSquare className="h-4 w-4 text-sky-300" />
            <span>Вопрос от пользователя</span>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">{question}</p>
        </section>
      )}

      {hasAnswerContent && (
        <section className="rounded-lg border border-slate-700 bg-slate-900/70 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Bot className="h-4 w-4 text-blue-300" />
            <span>Ответ от агентной системы</span>
          </div>
          {answer && (
            <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">{answer}</p>
          )}
          {papers.length > 0 && (
            <div className={answer ? 'mt-4 space-y-2' : 'space-y-2'}>
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <FileText className="h-4 w-4 text-emerald-300" />
                <span>Найденные статьи</span>
                <span className="text-xs font-normal text-slate-400">({papers.length})</span>
              </div>
              <div className="space-y-2">
                {papers.map((paper) => (
                  <article
                    key={paper.id}
                    className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2"
                  >
                    <div className="text-sm font-medium leading-5 text-slate-100">{paper.title}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
                      {paper.year && <span>{paper.year}</span>}
                      {paper.authors && <span>{paper.authors}</span>}
                      {paper.source && <span>{paper.source}</span>}
                      {paper.citedByCount && <span>Цитирований: {paper.citedByCount}</span>}
                      {paper.doi && <span>DOI: {paper.doi}</span>}
                      {paper.storageRef && <span>S3: {paper.storageRef}</span>}
                    </div>
                    {paper.summary && (
                      <p className="mt-2 text-xs leading-5 text-slate-300">{paper.summary}</p>
                    )}
                    {paper.pdfUrl && (
                      <a
                        href={paper.pdfUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Открыть источник
                      </a>
                    )}
                  </article>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {route.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <Route className="h-4 w-4 text-slate-400" />
          {route.map((item) => (
            <span key={item} className="rounded-full border border-slate-700 bg-slate-900 px-2 py-1">
              {item}
            </span>
          ))}
        </div>
      )}

      {!hasAnswerContent && (
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
          No structured research result was found in this approval snapshot.
        </div>
      )}
    </div>
  )
}
