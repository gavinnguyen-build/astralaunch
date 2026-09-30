/**
 * Bundled fallback for /feed/digest when there is no cached result and arXiv fails or times out: 5 real arXiv papers
 * on agent payments, copied verbatim (parseArxivAtom output) from
 *   https://export.arxiv.org/api/query?search_query=all:%22agent%20payments%22&sortBy=relevance&max_results=10
 * on 2026-10-01. Served with "source": "fallback sample", never as live data.
 */
import type { Paper } from './arxiv.js';

export const FALLBACK_FETCHED_AT = '2026-10-01T00:00:00.000Z';

export const FALLBACK_PAPERS: readonly Paper[] = [
  {
    "title": "A Formal Analysis of Agent Payment Protocols",
    "authors": [
      "Ke Jiang",
      "Mohan Yu",
      "Yuan Chang",
      "Mohit Kumar Jangid",
      "Jianyu Niu",
      "Cong Wang",
      "Yinqian Zhang"
    ],
    "link": "https://arxiv.org/abs/2609.00060v1",
    "summary": "Agent payment protocols are emerging as a key transaction layer for autonomous commerce, enabling AI agents to purchase goods and services and execute payments on users' behalf.",
    "published": "2026-08-30T14:04:15.000Z"
  },
  {
    "title": "Beyond the Mandate: A Systematic Security Analysis of the Agent Payments Protocol (AP2)",
    "authors": [
      "Avital Aviv",
      "Parth A. Gandh",
      "Ron Bitton",
      "Asaf Shabtai"
    ],
    "link": "https://arxiv.org/abs/2608.23858v1",
    "summary": "The Agent Payments Protocol (AP2), introduced by Google, enables large language model (LLM)-driven shopping agents to authorize and execute payments on behalf of users.",
    "published": "2026-08-24T22:05:00.000Z"
  },
  {
    "title": "Issuer-Sovereign Agentic Payments",
    "authors": [
      "Dishant Sharma",
      "Rajneesh Kaushal",
      "Ashu Kanaujia"
    ],
    "link": "https://arxiv.org/abs/2609.27452v1",
    "summary": "AI agents are beginning to make real payments.",
    "published": "2026-09-23T07:18:01.000Z"
  },
  {
    "title": "APEX: Agent Payment Execution with Policy for Autonomous Agent API Access",
    "authors": [
      "Mohd Safwan Uddin",
      "Mohammed Mouzam",
      "Mohammed Imran",
      "Syed Badar Uddin Faizan"
    ],
    "link": "https://arxiv.org/abs/2604.02023v1",
    "summary": "Autonomous agents are moving beyond simple retrieval tasks to become economic actors that invoke APIs, sequence workflows, and make real-time decisions.",
    "published": "2026-04-02T13:32:01.000Z"
  },
  {
    "title": "SoK: Blockchain Agent-to-Agent Payments",
    "authors": [
      "Yuanzhe Zhang",
      "Yuexin Xiang",
      "Yuchen Lei",
      "Qin Wang",
      "Tian Qiu",
      "Yujing Sun",
      "Spiridon Zarkov",
      "Tsz Hon Yuen",
      "Andreas Deppeler",
      "Jiangshan Yu",
      "Kwok-Yan Lam"
    ],
    "link": "https://arxiv.org/abs/2604.03733v1",
    "summary": "Agentic AI rivals human capabilities across a wide range of domains.",
    "published": "2026-04-04T13:26:17.000Z"
  },
];
