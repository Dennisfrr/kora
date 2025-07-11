// dashboard-backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getSession, closeDriver, neo4jDriver } = require('./db_neo4j'); // Assumindo que db_neo4j exporta o driver também
const neo4j = require('neo4j-driver');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { PersonaManager } = require('./personaManager');
const { FunnelManager } = require('./funnelManager');
// const { ReflectionAnalyticsTracker } = require('../kora-agent-files/reflectionAnalyticsTracker'); // Se fosse usar diretamente
const path = require('path');

const GEMINI_API_KEY_DASHBOARD = process.env.GEMINI_API_KEY_DASHBOARD || process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY_DASHBOARD) {
    console.warn("!!! AVISO: GEMINI_API_KEY_DASHBOARD não configurada. Funcionalidade de chat de insights não funcionará. !!!");
}
const genAIDashboard = GEMINI_API_KEY_DASHBOARD ? new GoogleGenerativeAI(GEMINI_API_KEY_DASHBOARD) : null;
const insightModel = genAIDashboard ? genAIDashboard.getGenerativeModel({ model: "gemini-1.5-flash-latest" }) : null;
const personaManager = new PersonaManager();
const funnelManager = new FunnelManager();

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3005;

app.use(cors());
app.use(express.json());

// --- Static files da Dashboard Front-End --------------------------------------
// Servimos diretório /dash como raiz estática. Assim, index.html acessível em http://localhost:PORT/
app.use(express.static(path.join(__dirname, 'dash')));

// Se for SPA, redireciona rota desconhecida para index.html
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dash', 'index.html'));
});

// --- Helpers (mantidos e expandidos) ---
async function closeSession(session) {
    if (session) {
        await session.close();
    }
}

function convertNeo4jProperties(properties) {
    if (!properties) return {};
    const result = {};
    for (const key in properties) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
            const value = properties[key];
            if (neo4j.isInt(value)) {
                result[key] = value.toNumber();
            } else if (neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value) || neo4j.isTime(value) || neo4j.isDuration(value)) {
                result[key] = value.toString();
            } else if (typeof value === 'bigint') {
                result[key] = Number(value);
            } else if (['dtCriacao', 'dtUltimaAtualizacao', 'createdAt', 'updatedAt', 'lastInteraction', 'timestamp', 'eventTimestamp', 'reflectionTimestamp', 'hypothesisTimestamp'].includes(key)) {
                 result[key] = convertNeo4jDateToISO(value, `prop-${key}`);
            } else if (Array.isArray(value)) {
                result[key] = value.map(item => {
                    if (neo4j.isInt(item)) return item.toNumber();
                    if (typeof item === 'bigint') return Number(item);
                    if (typeof item === 'object' && item !== null && !Array.isArray(item)) return convertNeo4jProperties(item); // Recursivo para objetos em arrays
                    return item;
                });
            } else if (typeof value === 'object' && value !== null) {
                result[key] = convertNeo4jProperties(value); // Recursivo para objetos aninhados
            }
            else {
                result[key] = value;
            }
        }
    }
    return result;
}


function convertNeo4jDateToISO(dateValue, debugContext = "") {
    if (dateValue === null || dateValue === undefined) return null;
    try {
        let timestampNumber;
        if (typeof dateValue === 'bigint') timestampNumber = Number(dateValue);
        else if (neo4j.isInt(dateValue)) timestampNumber = dateValue.toNumber();
        else if (neo4j.isDate(dateValue) || neo4j.isDateTime(dateValue) || neo4j.isLocalDateTime(dateValue)) {
             timestampNumber = new Date(
                dateValue.year.toNumber(), dateValue.month.toNumber() - 1, dateValue.day.toNumber(),
                dateValue.hour ? dateValue.hour.toNumber() : 0, dateValue.minute ? dateValue.minute.toNumber() : 0,
                dateValue.second ? dateValue.second.toNumber() : 0, dateValue.nanosecond ? dateValue.nanosecond.toNumber() / 1000000 : 0
            ).getTime();
        }
        else if (typeof dateValue === 'object' && dateValue.year && dateValue.month && dateValue.day) { // Fallback para objeto literal
             timestampNumber = new Date(
                dateValue.year, dateValue.month - 1, dateValue.day,
                dateValue.hour || 0, dateValue.minute || 0, dateValue.second || 0
            ).getTime();
        }
        else if (typeof dateValue === 'number') timestampNumber = dateValue;
        else if (typeof dateValue === 'string') {
            timestampNumber = Date.parse(dateValue);
            if (isNaN(timestampNumber)) {
                const numAttempt = Number(dateValue);
                if (!isNaN(numAttempt)) timestampNumber = numAttempt;
            }
        }

        if (timestampNumber !== undefined && !isNaN(timestampNumber)) return new Date(timestampNumber).toISOString();
        // console.warn(`[WARN ${debugContext}] Não foi possível converter dateValue para timestamp:`, dateValue, typeof dateValue);
        return String(dateValue); // Retorna como string se não puder converter
    } catch (e) {
        console.error(`[ERROR ${debugContext}] Erro ao converter data: `, e, `Valor original:`, dateValue);
        return String(dateValue);
    }
}

function neo4jIdToString(idField) {
    if (neo4j.isInt(idField)) return idField.toString();
    return String(idField);
}

function getNodeDisplayLabel(properties, labels) {
    if (properties.nome) return String(properties.nome);
    if (properties.name) return String(properties.name);
    if (properties.idWhatsapp) return `Lead: ${String(properties.idWhatsapp).substring(0,10)}...`;
    if (properties.type) return String(properties.type);
    if (labels && labels.length > 0) return labels.join(', ');
    return 'Nó Desconhecido';
}

function getNodeTitle(properties, labels, id) {
    let title = `ID: ${id}\nLabels: ${labels.join(', ')}\n`;
    for (const key in properties) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
            const value = properties[key];
            if (typeof value === 'object' && value !== null) {
                 if(Array.isArray(value)) title += `${key}: ${value.slice(0,3).join(', ')}${value.length > 3 ? '...' : ''}\n`;
                 else title += `${key}: [Objeto Complexo]\n`; // Evita stringify de objetos grandes
            } else title += `${key}: ${value}\n`;
        }
    }
    return title.trim();
}

// =========================================================================
// ENDPOINTS PARA KORA BRAIN DASHBOARD - CONFIGURAÇÃO DO AGENTE
// =========================================================================
app.get('/api/agent/config', async (req, res) => {
    try {
        const agentConfig = {
            agentName: process.env.NOME_DO_AGENTE || "Leo Consultor",
            llmModel: process.env.GEMINI_MODEL_NAME || "gemini-1.5-flash-latest",
            temperature: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.65,
            debounceDelayMs: parseInt(process.env.DEBOUNCE_DELAY_MS) || 7500,
            maxToolIterations: parseInt(process.env.MAX_TOOL_ITERATIONS) || 5,
            systemPromptBase: process.env.SYSTEM_INSTRUCTION_AGENTE_BASE || "Prompt base não configurado no backend do dashboard.",
            messageBreakDelimiter: process.env.DELIMITER_MSG_BREAK || "||MSG_BREAK||",
            messageLengthTarget: parseInt(process.env.MESSAGE_LENGTH_TARGET) || 160,
        };
        res.json(agentConfig);
    } catch (error) {
        console.error("Erro ao buscar configuração do agente:", error);
        res.status(500).json({ error: "Erro interno ao buscar configuração do agente" });
    }
});

app.put('/api/agent/config', async (req, res) => {
    console.log("Recebido PUT para /api/agent/config com corpo:", req.body);
    // TODO: Implementar lógica para ATUALIZAR a configuração do agente.
    // Isso é complexo, pois pode exigir recarregar/reiniciar o agente principal.
    // Poderia envolver salvar as configurações em um arquivo ou DB que o agente principal lê na inicialização.
    res.status(501).json({ message: "Atualização de configuração ainda não implementada." });
});

app.get('/api/agent/tools', async (req, res) => {
    try {
        // Simular a lista de ferramentas como definida no seu agente principal (index.js)
        // Idealmente, isso viria de uma configuração centralizada ou introspecção.
        const toolsFromAgent = [
            { id: "get_lead_profile", name: "get_lead_profile", description: "Obtém o perfil completo e atualizado de um lead...", isActive: true },
            { id: "get_knowledge_schemas_for_pains", name: "get_knowledge_schemas_for_pains", description: "Busca nos esquemas de conhecimento do Neo4j informações sobre Dores Comuns...", isActive: true },
            { id: "analyze_and_update_lead_profile", name: "analyze_and_update_lead_profile", description: "Analisa o histórico recente da conversa e o perfil conceitual atual...", isActive: true },
            { id: "get_relevant_case_studies_or_social_proof", name: "get_relevant_case_studies_or_social_proof", description: "Busca no banco de dados de conhecimento (Neo4j) por estudos de caso...", isActive: true },
        ];
        // TODO: O status 'isActive' viria de uma configuração persistida.
        res.json(toolsFromAgent);
    } catch (error) {
        console.error("Erro ao buscar ferramentas do agente:", error);
        res.status(500).json({ error: "Erro interno ao buscar ferramentas do agente" });
    }
});

app.put('/api/agent/tools/:toolId/status', async (req, res) => {
    const { toolId } = req.params;
    const { isActive } = req.body;
    // TODO: Implementar lógica para persistir o status da ferramenta.
    console.log(`Recebido PUT para /api/agent/tools/${toolId}/status com isActive: ${isActive}`);
    res.status(501).json({ message: `Atualização de status para ferramenta ${toolId} não implementada.` });
});

app.get('/api/agent/planner/plans', async (req, res) => {
    try {
        // Assumindo que você pode requerer o PLANS diretamente do arquivo do agente
        // Esta é uma simplificação. Em produção, os planos podem ser carregados de um DB ou config.
        const plansFromAgent = require('../kora-agent-files/planner').PLANS;
        const formattedPlans = Object.entries(plansFromAgent).map(([id, planData], index) => ({
            id: id, // Usar o nome do plano como ID
            name: id,
            goal: planData.goal,
            steps: planData.steps.map((step, stepIndex) => ({
                id: `${id}_step${stepIndex+1}`,
                name: step.name,
                objective: step.objective,
                completionCriteria: step.completion_check ? step.completion_check.toString().substring(0, 100) + "..." : "Não definido",
                guidanceForLLM: step.guidance_for_llm,
                onFailureNextStep: step.on_failure_next_step || null,
                maxRetries: step.max_retries || (require('../kora-agent-files/planner').MAX_RETRIES_PER_STEP || 2), // Exemplo
                isActive: true // TODO: Gerenciar status da etapa
            }))
        }));
        res.json(formattedPlans);
    } catch (error) {
        console.error("Erro ao buscar planos do planner:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar planos do planner", details: error.message });
    }
});
// TODO: Endpoints para CRUD de Planos (POST, PUT, DELETE) para permitir edição via dashboard.

// =========================================================================
// ENDPOINTS PARA LEADS - MAIS DADOS!
// =========================================================================
app.get('/api/leads/:id', async (req, res) => {
    const { id: leadWhatsappId } = req.params;
    const neo4jSession = await getSession();
    try {
        // Query principal para dados do Lead e seus relacionamentos diretos
        const leadResult = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $leadWhatsappId})
            OPTIONAL MATCH (l)-[:TEM_DOR]->(d:Dor)
            OPTIONAL MATCH (l)-[:TEM_INTERESSE]->(i:Interesse)
            OPTIONAL MATCH (l)-[:DISCUTIU_SOLUCAO]->(s:Solucao)
            OPTIONAL MATCH (l)-[:HAS_CONCEPTUAL_MEMORY]->(cm:ConceptualMemory)
            OPTIONAL MATCH (l)-[:HAS_PLANNER_HISTORY]->(ph:PlannerHistoryEvent) // Novo: Histórico do Planner
            OPTIONAL MATCH (l)-[:HAS_REFLECTION]->(refl:Reflection) // Novo: Reflexões
            OPTIONAL MATCH (l)-[:GENERATED_HYPOTHESIS]->(hyp:Hypothesis) // Novo: Hipóteses

            WITH l,
                 collect(DISTINCT d { .name, .descricao }) AS dores,
                 collect(DISTINCT i { .name, .descricao }) AS interesses,
                 collect(DISTINCT s { .name, .descricao }) AS solucoesDiscutidas,
                 collect(DISTINCT cm {.*, id: elementId(cm)}) AS memoriasConceituais,
                 collect(DISTINCT ph { .planName, .stepName, .status, .timestamp, .details }) AS plannerHistory, // Últimos 5 eventos do planner (truncated to avoid invalid ORDER BY/LIMIT inside collect)
                 collect(DISTINCT refl { .summary, .focusType, .timestamp }) AS recentReflections, // Últimas 3 reflexões (resumo) - ORDER BY/LIMIT removidos
                 collect(DISTINCT hyp { .interpretation, .confidence, .timestamp }) AS recentHypotheses // Últimas 3 hipóteses (resumo) - ORDER BY/LIMIT removidos

            RETURN l {
                .*,
                id: l.idWhatsapp,
                name: l.nome,
                businessName: l.nomeDoNegocio,
                businessType: l.tipoDeNegocio,
                pains: dores,
                interests: interesses,
                discussedSolutions: solucoesDiscutidas,
                meetingInterest: l.nivelDeInteresseReuniao,
                lastSummary: l.ultimoResumoDaSituacao,
                activeHypotheses: CASE WHEN l.activeHypotheses IS NULL THEN [] ELSE l.activeHypotheses END,
                conceptualMemories: memoriasConceituais,
                currentPlanName: l.currentPlanName, // Assumindo que estes campos são salvos no Lead
                currentPlanStep: l.currentPlanStep,
                currentPlanStatus: l.currentPlanStatus,
                lastInteraction: l.dtUltimaAtualizacao,
                tags: CASE WHEN l.tags IS NULL THEN [] ELSE l.tags END,
                plannerHistorySummary: plannerHistory, // Resumo do histórico do planner
                recentReflectionsSummary: recentReflections, // Resumo das reflexões
                recentHypothesesSummary: recentHypotheses // Resumo das hipóteses
            } AS lead
        `, { leadWhatsappId });

        if (leadResult.records.length === 0) {
            return res.status(404).json({ error: "Lead não encontrado" });
        }
        
        let leadData = convertNeo4jProperties(leadResult.records[0].get('lead'));
        
        // Simular lastLatentInterpretations (poderia vir de hipóteses recentes do MeaningSupervisor)
        leadData.lastLatentInterpretations = (leadData.activeHypotheses || [])
            .filter(h => h.source === 'MeaningSupervisor' && h.type === 'IntentInterpretation') // Assumindo essa estrutura
            .sort((a,b) => (new Date(b.createdAt || 0).getTime()) - (new Date(a.createdAt || 0).getTime()))
            .slice(0,3)
            .map(h => ({
                interpretation: h.description ? h.description.replace('Hipótese de intenção: "', '').replace(/" \(Foco sugerido: .*\)/, '') : 'N/A',
                confidenceScore: h.confidence,
                suggestedAgentFocus: h.description ? (h.description.match(/Foco sugerido: (.*?)\)/)?.[1] || 'N/A') : 'N/A',
                potentialUserGoal: h.details?.potentialUserGoal || 'N/A',
                emotionalToneHint: h.details?.emotionalToneHint || 'N/A',
                timestamp: h.createdAt
            }));
        
        res.json(leadData);
    } catch (error) {
        console.error(`Erro ao buscar detalhes do lead ${leadWhatsappId}:`, error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar detalhes do lead", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/leads/:id/chathistory', async (req, res) => {
    const { id: leadId } = req.params;
    const neo4jSession = await getSession();
    try {
        // Esta query assume que você armazena mensagens como nós :Message
        // e as relaciona com o :Lead através de :SENT_MESSAGE ou :RECEIVED_MESSAGE.
        // E que as mensagens têm 'role' ('user' ou 'model'/'agent'), 'text' e 'timestamp'.
        const result = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $leadId})
            MATCH (l)-[r:INTERACTED_WITH]-(msg:Message) // Ou qualquer que seja sua estrutura de mensagens
            RETURN msg.role AS role, msg.text AS text, msg.timestamp AS timestamp, msg.type as messageType, msg.toolCallName, msg.toolCallArgs, msg.toolResponseContent
            ORDER BY msg.timestamp ASC
            LIMIT 200 // Limitar para evitar sobrecarga
        `, { leadId });

        const chatHistory = result.records.map(record => {
            const rawMsg = {
                role: record.get('role'),
                parts: [{ text: record.get('text') }], // Estrutura Gemini
                timestamp: convertNeo4jDateToISO(record.get('timestamp'), 'chathistory-ts'),
                messageType: record.get('messageType') || 'text', // e.g. 'text', 'tool_call', 'tool_response'
                // Campos adicionais se for uma chamada de ferramenta ou resposta
                toolCall: record.get('toolCallName') ? { name: record.get('toolCallName'), args: record.get('toolCallArgs') } : undefined,
                toolResponse: record.get('toolCallName') && record.get('toolResponseContent') ? { name: record.get('toolCallName'), content: record.get('toolResponseContent')} : undefined
            };
            // Limpa undefined
            Object.keys(rawMsg).forEach(key => rawMsg[key] === undefined && delete rawMsg[key]);
            if (rawMsg.toolCall && rawMsg.toolResponse) delete rawMsg.parts; // Se for tool_call completo, não precisa de 'parts'
            return rawMsg;
        });

        if (chatHistory.length === 0) {
            // Retornar mock se não houver histórico real, para manter a funcionalidade do frontend
            console.log(`Nenhum histórico de chat real encontrado para lead ${leadId}, retornando mock.`);
            return res.json([
                {role: "user", parts: [{text: `(Mock) Olá, sou o lead ${leadId}.`}], timestamp: new Date(Date.now() - 7200000).toISOString()},
                {role: "model", parts: [{text: `(Mock) Olá ${leadId}! Como posso ajudar?`}], timestamp: new Date(Date.now() - 7100000).toISOString()},
            ]);
        }
        res.json(chatHistory);
    } catch (error) {
        console.error(`Erro ao buscar histórico de chat para lead ${leadId}:`, error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar histórico de chat", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/leads/:id/interaction-events', async (req, res) => {
    const { id: leadId } = req.params;
    const neo4jSession = await getSession();
    try {
        // Esta é uma query SIMULADA. Você precisaria criar nós :InteractionEvent no Neo4j
        // com propriedades como eventType, eventTimestamp, details, etc.
        const result = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $leadId})-[:HAD_EVENT]->(e:InteractionEvent)
            RETURN e.eventType AS type, e.eventTimestamp AS timestamp, e.details AS details, e.source AS source
            ORDER BY e.eventTimestamp DESC
            LIMIT 50
        `, { leadId });

        const events = result.records.map(record => convertNeo4jProperties(record.toObject()));

        if (events.length === 0) {
            // Mock data if no real events found
            return res.json([
                { type: "MessageSent", timestamp: new Date(Date.now() - 300000).toISOString(), details: { role: "agent", text: "Olá! Como posso ajudar?" }, source: "AgentCore" },
                { type: "MessageReceived", timestamp: new Date(Date.now() - 240000).toISOString(), details: { role: "user", text: "Tenho uma dúvida sobre o produto X." }, source: "UserInteraction" },
                { type: "ToolCalled", timestamp: new Date(Date.now() - 180000).toISOString(), details: { name: "get_knowledge_schemas_for_pains", args: {pains: ["produto X"]} }, source: "AgentCore" },
                { type: "PlannerStepChanged", timestamp: new Date(Date.now() - 120000).toISOString(), details: { oldStep: "InitialContact", newStep: "PainDiscovery", plan: "LeadQualification" }, source: "Planner" },
                { type: "ReflectionGenerated", timestamp: new Date(Date.now() - 60000).toISOString(), details: { focus: "LEAD_SENTIMENT_ENGAGEMENT", summary: "Lead parece curioso." }, source: "ReflectiveAgent" },
            ]);
        }
        res.json(events);
    } catch (error) {
        console.error(`Erro ao buscar eventos de interação para lead ${leadId}:`, error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar eventos de interação", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/leads/:id/planner-history', async (req, res) => {
    const { id: leadId } = req.params;
    const neo4jSession = await getSession();
    try {
        // Assumindo que o histórico do planner é armazenado como nós :PlannerHistoryEvent
        const result = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $leadId})-[:HAS_PLANNER_HISTORY]->(ph:PlannerHistoryEvent)
            RETURN ph { .planName, .stepName, .status, .timestamp, .details, .retries, .objective, .guidanceGiven } AS historyEvent
            ORDER BY ph.timestamp ASC
        `, { leadId });
        
        const history = result.records.map(record => convertNeo4jProperties(record.get('historyEvent')));
        
        if (history.length === 0) {
            return res.json([{ planName: "LeadQualificationToMeeting", stepName: "InitialContactAndPainDiscovery", status: "active", timestamp: new Date().toISOString(), details: "Plano iniciado (mock)" }]);
        }
        res.json(history);
    } catch (error) {
        console.error(`Erro ao buscar histórico do planner para lead ${leadId}:`, error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar histórico do planner", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/leads/:id/all-reflections', async (req, res) => {
    const { id: leadId } = req.params;
    const neo4jSession = await getSession();
    try {
        // Assumindo que reflexões completas são armazenadas como nós :Reflection
        const result = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $leadId})-[:HAS_REFLECTION]->(r:Reflection)
            RETURN r { .* } AS reflection // Retorna todas as propriedades da reflexão
            ORDER BY r.reflectionTimestamp DESC
            LIMIT 20
        `, { leadId });
        const reflections = result.records.map(record => convertNeo4jProperties(record.get('reflection')));
        if (reflections.length === 0) {
            return res.json([{ leadId, summary: "Nenhuma reflexão encontrada (mock).", reflectionTimestamp: new Date().toISOString() }]);
        }
        res.json(reflections);
    } catch (error) {
        console.error(`Erro ao buscar todas as reflexões para lead ${leadId}:`, error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar reflexões", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/leads/:id/all-hypotheses', async (req, res) => {
    const { id: leadId } = req.params;
    const neo4jSession = await getSession();
    try {
        // Assumindo que hipóteses completas são armazenadas como nós :Hypothesis
        const result = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $leadId})-[:GENERATED_HYPOTHESIS]->(h:Hypothesis)
            RETURN h { .* } AS hypothesis // Retorna todas as propriedades da hipótese
            ORDER BY h.hypothesisTimestamp DESC
            LIMIT 50 
        `, { leadId });
        const hypotheses = result.records.map(record => convertNeo4jProperties(record.get('hypothesis')));
        if (hypotheses.length === 0) {
            return res.json([{ leadId, interpretation: "Nenhuma hipótese encontrada (mock).", confidenceScore: 0.5, hypothesisTimestamp: new Date().toISOString() }]);
        }
        res.json(hypotheses);
    } catch (error) {
        console.error(`Erro ao buscar todas as hipóteses para lead ${leadId}:`, error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar hipóteses", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});


// =========================================================================
// ENDPOINTS DE ANALYTICS (Alguns mantidos, outros expandidos/novos)
// =========================================================================
app.get('/api/analytics/overview', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const totalReflectionsResult = await neo4jSession.run(`MATCH (r:Reflection) RETURN count(r) AS total`); // Usando :Reflection
        const totalReflections = totalReflectionsResult.records[0] ? totalReflectionsResult.records[0].get('total').toNumber() : 0;

        const totalLeadsResult = await neo4jSession.run(`MATCH (l:Lead) RETURN count(l) AS total`);
        const activeLeads = totalLeadsResult.records[0] ? totalLeadsResult.records[0].get('total').toNumber() : 0;

        const meetingsScheduledResult = await neo4jSession.run(`MATCH (l:Lead {nivelDeInteresseReuniao: "agendado"}) RETURN count(l) AS total`);
        const meetingsScheduled = meetingsScheduledResult.records[0] ? meetingsScheduledResult.records[0].get('total').toNumber() : 0;
        
        // Média de sucesso do plano (exemplo, precisaria de nós :PlannerExecution ou similar)
        const avgPlanSuccessResult = await neo4jSession.run(`
            MATCH (pe:PlannerExecution) // Nó hipotético para registrar execuções de planos
            RETURN avg(CASE pe.status WHEN "completed" THEN 1.0 ELSE 0.0 END) * 100 AS avgRate
        `);
        const avgPlanSuccessRate = avgPlanSuccessResult.records.length > 0 && avgPlanSuccessResult.records[0].get('avgRate') !== null 
            ? avgPlanSuccessResult.records[0].get('avgRate') 
            : 65; // Mock se não houver dados

        res.json({
            totalReflections: totalReflections,
            activeLeads: activeLeads,
            meetingsScheduled: meetingsScheduled,
            averagePlanSuccessRate: parseFloat(avgPlanSuccessRate.toFixed(2)),
        });
    } catch (error) {
        console.error("Erro ao buscar overview de analytics:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar overview de analytics", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/analytics/plan-success', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        // Query para buscar taxa de sucesso por plano (assumindo nós :PlannerExecution)
        const result = await neo4jSession.run(`
            MATCH (pe:PlannerExecution)
            RETURN pe.planName AS name, 
                   avg(CASE pe.status WHEN "completed" THEN 1.0 ELSE 0.0 END) * 100 AS successRate,
                   count(pe) AS totalRuns
        `);
        const planSuccessData = result.records.map(record => ({
            name: record.get('name'),
            successRate: parseFloat(record.get('successRate').toFixed(2)),
            totalRuns: record.get('totalRuns').toNumber()
        }));

        if (planSuccessData.length === 0) {
            return res.json([ // Mock
                { name: 'LeadQualificationToMeeting', successRate: 75, totalRuns: 80 },
                { name: 'ColdLeadReEngagement', successRate: 60, totalRuns: 50 },
            ]);
        }
        res.json(planSuccessData);
    } catch (error) {
        console.error("Erro ao buscar taxa de sucesso por plano:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar taxa de sucesso por plano", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/analytics/sentiment-distribution', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        // Assumindo que :Reflection armazena 'sentimentoInferidoDoLead'
        const result = await neo4jSession.run(`
            MATCH (r:Reflection)
            WHERE r.sentimentoInferidoDoLead IS NOT NULL
            RETURN r.sentimentoInferidoDoLead AS name, count(r) AS value
        `);
        const sentimentDistribution = result.records.map(record => ({
            name: record.get('name'),
            value: record.get('value').toNumber()
        }));
        res.json(sentimentDistribution.length > 0 ? sentimentDistribution : [ { name: 'Não Coletado', value: 100 } ]);
    } catch (error) {
        console.error("Erro ao buscar distribuição de sentimentos:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar distribuição de sentimentos", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/analytics/tool-usage', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        // Assumindo que chamadas de ferramenta são logadas como :ToolCallEvent
        const result = await neo4jSession.run(`
            MATCH (tc:ToolCallEvent) // Nó hipotético
            RETURN tc.toolName AS name, count(tc) AS value, avg(tc.durationMs) AS avgDurationMs, sum(CASE tc.status WHEN 'success' THEN 1 ELSE 0 END) AS successCount
        `);
        const toolUsage = result.records.map(record => ({
            name: record.get('name'),
            value: record.get('value').toNumber(),
            avgDurationMs: record.get('avgDurationMs') ? parseFloat(record.get('avgDurationMs').toFixed(1)) : null,
            successRate: record.get('value').toNumber() > 0 ? parseFloat(((record.get('successCount').toNumber() / record.get('value').toNumber()) * 100).toFixed(1)) : 0
        }));

        if (toolUsage.length === 0) {
            return res.json([ // Mock
                {name: 'get_lead_profile', value: 120, avgDurationMs: 150.5, successRate: 98.2}, 
                {name: 'get_knowledge_schemas_for_pains', value: 90, avgDurationMs: 350.0, successRate: 92.1},
                {name: 'analyze_and_update_lead_profile', value: 70, avgDurationMs: 1200.7, successRate: 85.0}, 
                {name: 'get_relevant_case_studies_or_social_proof', value: 40, avgDurationMs: 450.2, successRate: 95.5}
            ]);
        }
        res.json(toolUsage);
    } catch (error) {
        console.error("Erro ao buscar uso de ferramentas:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar uso de ferramentas", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/analytics/effective-tactics', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        // Query mais complexa: correlacionar 'acaoPrincipalRealizadaPeloAgente' de :Reflection
        // com 'objetivoDaEtapaDoPlannerAvancou' ou mudança positiva no 'sentimentoInferidoDoLead'
        // Esta é uma simplificação.
        const result = await neo4jSession.run(`
            MATCH (r:Reflection)
            WHERE r.acaoPrincipalRealizadaPeloAgente IS NOT NULL AND r.objetivoDaEtapaDoPlannerAvancou IS NOT NULL
            RETURN r.acaoPrincipalRealizadaPeloAgente AS tactic, 
                   avg(CASE r.objetivoDaEtapaDoPlannerAvancou WHEN true THEN 1.0 ELSE 0.0 END) AS effectivenessScore,
                   count(r) AS count
            ORDER BY effectivenessScore DESC, count DESC
            LIMIT 10
        `);
        const tactics = result.records.map(record => ({
            tactic: record.get('tactic'),
            effectivenessScore: parseFloat(record.get('effectivenessScore').toFixed(2)),
            count: record.get('count').toNumber()
        }));
        if (tactics.length === 0) {
            return res.json([ // Mock
                { tactic: "Apresentar Prova Social Específica", effectivenessScore: 0.85, count: 30 },
                { tactic: "Perguntar sobre Impacto Financeiro da Dor", effectivenessScore: 0.78, count: 45 },
            ]);
        }
        res.json(tactics);
    } catch (error) {
        console.error("Erro ao buscar táticas eficazes:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar táticas eficazes", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

// NOVO: Endpoint para métricas do ReflectionAnalyticsTracker (se os dados fossem persistidos no Neo4j)
app.get('/api/analytics/tracker-metrics/:planName', async (req, res) => {
    const { planName } = req.params;
    const neo4jSession = await getSession();
    try {
        // Supondo que ReflectionDataPoint (do tracker) é salvo como :Reflection no Neo4j
        const result = await neo4jSession.run(`
            MATCH (r:Reflection)
            WHERE r.planName = $planName
            WITH collect(r) AS reflections
            UNWIND reflections AS reflection
            WITH reflection.planName AS planName,
                 count(reflection) AS totalReflections,
                 sum(CASE reflection.stepGoalAchieved WHEN true THEN 1 ELSE 0 END) AS successfulSteps,
                 apoc.coll.frequenciesAsMap(collect(reflection.inferredLeadSentiment)) AS sentimentCounts // Usando APOC para contagem de sentimentos
            RETURN planName, totalReflections, successfulSteps, 
                   (toFloat(successfulSteps) / totalReflections) * 100 AS successRate,
                   sentimentCounts
        `, { planName });

        if (result.records.length > 0) {
            const record = result.records[0];
            const sentimentMap = record.get('sentimentCounts');
            const formattedSentiments = {};
            for(const item of sentimentMap){ // APOC frequenciesAsMap retorna lista de objetos {value: count}
                if(item.value) formattedSentiments[item.value] = item.count.toNumber();
            }

            res.json({
                planName: record.get('planName'),
                totalReflections: record.get('totalReflections').toNumber(),
                successfulSteps: record.get('successfulSteps').toNumber(),
                successRate: parseFloat(record.get('successRate').toFixed(2)),
                sentimentCounts: formattedSentiments
            });
        } else {
            res.json({ planName, totalReflections: 0, successfulSteps: 0, successRate: 0, sentimentCounts: { "mock_sentiment": 10 } });
        }
    } catch (error) {
        console.error(`Erro ao buscar métricas do tracker para o plano ${planName}:`, error.message, error.stack);
        // Verificar se o erro é por falta de APOC
        if (error.message.toLowerCase().includes("unknown function 'apoc")) {
             return res.status(501).json({ error: "Funcionalidade de agregação (APOC) não disponível no Neo4j.", details: error.message });
        }
        res.status(500).json({ error: `Erro interno ao buscar métricas do tracker para ${planName}`, details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});


// =========================================================================
// ENDPOINTS PARA BASE DE CONHECIMENTO (KB) - Aprimorado
// =========================================================================
app.get('/api/knowledgebase/stats', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const stats = {};
        const nodeTypes = ['DorComum', 'SolucaoOferecida', 'ObjecaoComum', 'KnowledgeTopic', 'SocialProof', 'Industry'];
        for (const type of nodeTypes) {
            const result = await neo4jSession.run(`MATCH (n:${type}) RETURN count(n) AS count`);
            stats[type] = result.records[0] ? result.records[0].get('count').toNumber() : 0;
        }
        res.json({
            commonPains: stats['DorComum'] || 0,
            solutionsOffered: stats['SolucaoOferecida'] || 0,
            commonObjections: stats['ObjecaoComum'] || 0,
            knowledgeTopics: stats['KnowledgeTopic'] || 0,
            socialProofs: stats['SocialProof'] || 0,
            industries: stats['Industry'] || 0,
        });
    } catch (error) {
        console.error("Erro ao buscar estatísticas da base de conhecimento:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar estatísticas da base de conhecimento", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/knowledgebase/items/:nodeType', async (req, res) => {
    const { nodeType } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const neo4jSession = await getSession();
    try {
        const allowedNodeTypes = ['DorComum', 'SolucaoOferecida', 'ObjecaoComum', 'KnowledgeTopic', 'SocialProof', 'Industry'];
        if (!allowedNodeTypes.includes(nodeType)) {
            return res.status(400).json({ error: "Tipo de nó inválido." });
        }

        // Query para buscar itens e alguns de seus relacionamentos diretos
        // Exemplo: Para SolucaoOferecida, buscar Dores que resolve e Objeções que pode gerar.
        let itemQuery = `MATCH (n:${nodeType}) RETURN n { .*, id: elementId(n) } AS item ORDER BY n.name SKIP $skip LIMIT $limit`;
        let countQuery = `MATCH (n:${nodeType}) RETURN count(n) AS total`;

        if (nodeType === 'SolucaoOferecida') {
            itemQuery = `
                MATCH (n:SolucaoOferecida)
                OPTIONAL MATCH (n)-[:RESOLVE]->(d:DorComum)
                OPTIONAL MATCH (n)-[:PODE_GERAR]->(o:ObjecaoComum)
                OPTIONAL MATCH (n)-[:RELATES_TO_TOPIC]->(t:KnowledgeTopic)
                WITH n, collect(DISTINCT d.name) AS resolvesPains, collect(DISTINCT o.name) AS canGenerateObjections, collect(DISTINCT t.name) AS relatedTopics
                RETURN n { .*, id: elementId(n), resolvesPains: resolvesPains, canGenerateObjections: canGenerateObjections, relatedTopics: relatedTopics } AS item
                ORDER BY n.name SKIP $skip LIMIT $limit
            `;
        } else if (nodeType === 'DorComum') {
             itemQuery = `
                MATCH (n:DorComum)
                OPTIONAL MATCH (s:SolucaoOferecida)-[:RESOLVE]->(n)
                OPTIONAL MATCH (n)-[:PODE_GERAR]->(o:ObjecaoComum)
                WITH n, collect(DISTINCT s.name) AS resolvedBySolutions, collect(DISTINCT o.name) AS canGenerateObjections
                RETURN n { .*, id: elementId(n), resolvedBySolutions: resolvedBySolutions, canGenerateObjections: canGenerateObjections } AS item
                ORDER BY n.name SKIP $skip LIMIT $limit
            `;
        }
        // Adicionar mais lógicas para outros tipos se necessário

        const result = await neo4jSession.run(itemQuery, { skip: neo4j.int(skip), limit: neo4j.int(parseInt(limit)) });
        const items = result.records.map(record => convertNeo4jProperties(record.get('item')));
        
        const totalResult = await neo4jSession.run(countQuery);
        const totalItems = totalResult.records[0] ? totalResult.records[0].get('total').toNumber() : 0;
        const totalPages = Math.ceil(totalItems / parseInt(limit));

        res.json({ data: items, page: parseInt(page), limit: parseInt(limit), totalItems, totalPages });
    } catch (error) {
        console.error(`Erro ao buscar itens para ${nodeType}:`, error.message, error.stack);
        res.status(500).json({ error: `Erro interno ao buscar itens para ${nodeType}`, details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});
// TODO: Endpoints CRUD para itens da Base de Conhecimento (POST, PUT, DELETE)

// =========================================================================
// ENDPOINTS DE SISTEMA / GERAIS - NOVOS
// =========================================================================
app.get('/api/system/errors', async (req, res) => {
    // Em um sistema real, isso leria de um arquivo de log ou de uma coleção de erros no DB.
    // Por agora, mock.
    const mockErrors = [
        { timestamp: new Date(Date.now() - 3600000).toISOString(), level: "ERROR", message: "Falha ao conectar ao serviço X", component: "AgentCore", details: "Timeout após 30s" },
        { timestamp: new Date(Date.now() - 7200000).toISOString(), level: "WARN", message: "API da Gemini retornou status 429 (Too Many Requests)", component: "ReflectiveAgent", leadId: "55119XXXXXXXX@c.us" },
    ];
    res.json(mockErrors);
});

app.get('/api/system/tool-performance', async (req, res) => {
    // Reutilizando a lógica de /api/analytics/tool-usage, que já é bem completa
    // Esta é uma duplicata funcional, mas pode ser mantida para clareza semântica se /system focar em "saúde/config"
    // e /analytics em "resultados de negócio".
    const neo4jSession = await getSession();
    try {
        const result = await neo4jSession.run(`
            MATCH (tc:ToolCallEvent) // Nó hipotético
            RETURN tc.toolName AS name, 
                   count(tc) AS totalCalls, 
                   avg(tc.durationMs) AS avgDurationMs, 
                   sum(CASE tc.status WHEN 'success' THEN 1 ELSE 0 END) AS successCount,
                   sum(CASE tc.status WHEN 'error' THEN 1 ELSE 0 END) AS errorCount
        `);
        const toolPerformance = result.records.map(record => ({
            name: record.get('name'),
            totalCalls: record.get('totalCalls').toNumber(),
            avgDurationMs: record.get('avgDurationMs') ? parseFloat(record.get('avgDurationMs').toFixed(1)) : null,
            successCount: record.get('successCount').toNumber(),
            errorCount: record.get('errorCount').toNumber(),
            successRate: record.get('totalCalls').toNumber() > 0 ? parseFloat(((record.get('successCount').toNumber() / record.get('totalCalls').toNumber()) * 100).toFixed(1)) : 0
        }));

        if (toolPerformance.length === 0) {
            return res.json([ // Mock
                {name: 'get_lead_profile', totalCalls: 120, avgDurationMs: 150.5, successCount: 118, errorCount: 2, successRate: 98.3}, 
                {name: 'analyze_and_update_lead_profile', totalCalls: 70, avgDurationMs: 1200.7, successCount: 60, errorCount: 10, successRate: 85.7}
            ]);
        }
        res.json(toolPerformance);
    } catch (error) {
        console.error("Erro ao buscar performance de ferramentas:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar performance de ferramentas", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/planner/general-stats', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        // Assumindo nós :PlannerExecution para estatísticas de planos
        const result = await neo4jSession.run(`
            MATCH (pe:PlannerExecution)
            WITH pe.planName AS planName, 
                 pe.status AS status, 
                 count(pe) AS count, 
                 avg(pe.durationSeconds) AS avgDurationSeconds // Assumindo que você loga a duração
            RETURN planName, status, count, avgDurationSeconds
        `);

        const statsByPlan = {};
        result.records.forEach(record => {
            const planName = record.get('planName');
            if (!statsByPlan[planName]) {
                statsByPlan[planName] = {
                    name: planName,
                    totalExecutions: 0,
                    statuses: {},
                    totalDurationSeconds: 0,
                    avgDurationSeconds: 0
                };
            }
            const status = record.get('status');
            const count = record.get('count').toNumber();
            statsByPlan[planName].totalExecutions += count;
            statsByPlan[planName].statuses[status] = (statsByPlan[planName].statuses[status] || 0) + count;
            if (record.get('avgDurationSeconds') !== null) {
                // Para calcular a média ponderada correta, precisaríamos da soma total e contar
                // Esta é uma simplificação se avgDurationSeconds já for a média por status/plano
                statsByPlan[planName].totalDurationSeconds += (record.get('avgDurationSeconds') * count);
            }
        });

        Object.values(statsByPlan).forEach(plan => {
            if (plan.totalExecutions > 0 && plan.totalDurationSeconds > 0) {
                plan.avgDurationSeconds = parseFloat((plan.totalDurationSeconds / plan.totalExecutions).toFixed(1));
            }
        });
        
        if (Object.keys(statsByPlan).length === 0) {
            return res.json({ // Mock
                "LeadQualificationToMeeting": { name: "LeadQualificationToMeeting", totalExecutions: 100, statuses: { "completed": 70, "failed": 20, "active": 10 }, avgDurationSeconds: 1800.5 },
                "ColdLeadReEngagement": { name: "ColdLeadReEngagement", totalExecutions: 50, statuses: { "completed": 25, "failed": 15, "active": 10 }, avgDurationSeconds: 950.0 }
            });
        }
        res.json(statsByPlan);
    } catch (error) {
        console.error("Erro ao buscar estatísticas gerais do planner:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar estatísticas do planner", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/reflective-agent/general-stats', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        // Assumindo nós :Reflection para estatísticas
        const result = await neo4jSession.run(`
            MATCH (r:Reflection)
            WITH r.focusType AS focusType, 
                 r.objetivoDaEtapaDoPlannerAvancou AS plannerAdvanced,
                 r.necessidadeDeAjusteNaAbordagem AS needsAdjustment,
                 count(r) AS count
            RETURN focusType, plannerAdvanced, needsAdjustment, count
        `);
        
        const stats = {
            byFocusType: {},
            totalReflections: 0,
            totalPlannerAdvanced: 0,
            totalNeedsAdjustment: 0,
        };

        result.records.forEach(record => {
            const focus = record.get('focusType') || "N/A";
            const count = record.get('count').toNumber();
            stats.totalReflections += count;
            if (record.get('plannerAdvanced') === true) stats.totalPlannerAdvanced += count;
            if (record.get('needsAdjustment') === true) stats.totalNeedsAdjustment += count;
            
            if (!stats.byFocusType[focus]) stats.byFocusType[focus] = { count: 0, plannerAdvanced: 0, needsAdjustment: 0 };
            stats.byFocusType[focus].count += count;
            if (record.get('plannerAdvanced') === true) stats.byFocusType[focus].plannerAdvanced += count;
            if (record.get('needsAdjustment') === true) stats.byFocusType[focus].needsAdjustment += count;
        });

        if (stats.totalReflections === 0) {
            return res.json({ // Mock
                byFocusType: { "GENERAL_PROGRESS": { count: 150, plannerAdvanced: 100, needsAdjustment: 30 }, "LEAD_SENTIMENT_ENGAGEMENT": { count: 50, plannerAdvanced: 20, needsAdjustment: 15 } },
                totalReflections: 200, totalPlannerAdvanced: 120, totalNeedsAdjustment: 45
            });
        }
        res.json(stats);
    } catch (error) {
        console.error("Erro ao buscar estatísticas do Reflective Agent:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar estatísticas do Reflective Agent", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/meaning-supervisor/general-stats', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        // Assumindo nós :Hypothesis para estatísticas
        const result = await neo4jSession.run(`
            MATCH (h:Hypothesis)
            WITH h.suggestedAgentFocus AS suggestedFocus, 
                 avg(h.confidenceScore) AS avgConfidence, // Média de confiança por foco
                 count(h) AS count
            RETURN suggestedFocus, avgConfidence, count
            ORDER BY count DESC
        `);
        
        const stats = {
            bySuggestedFocus: {},
            totalHypotheses: 0,
            overallAvgConfidence: 0 // Será calculado
        };
        let totalConfidenceSum = 0;

        result.records.forEach(record => {
            const focus = record.get('suggestedFocus') || "N/A";
            const count = record.get('count').toNumber();
            const avgConf = record.get('avgConfidence');

            stats.totalHypotheses += count;
            if (avgConf !== null) totalConfidenceSum += (avgConf * count);

            stats.bySuggestedFocus[focus] = {
                count: count,
                avgConfidence: avgConf !== null ? parseFloat(avgConf.toFixed(2)) : null
            };
        });
        
        if (stats.totalHypotheses > 0 && totalConfidenceSum > 0) {
            stats.overallAvgConfidence = parseFloat((totalConfidenceSum / stats.totalHypotheses).toFixed(2));
        }

        if (stats.totalHypotheses === 0) {
            return res.json({ // Mock
                bySuggestedFocus: { "Esclarecer dúvida X": { count: 100, avgConfidence: 0.75 }, "Validar objeção Y": { count: 80, avgConfidence: 0.65 } },
                totalHypotheses: 180, overallAvgConfidence: 0.70
            });
        }
        res.json(stats);
    } catch (error) {
        console.error("Erro ao buscar estatísticas do Meaning Supervisor:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno ao buscar estatísticas do Meaning Supervisor", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});


// =========================================================================
// ENDPOINTS EXISTENTES (Mantidos e verificados)
// =========================================================================
app.get('/api/stats/geral-periodo', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const { startDate, endDate } = req.query; 
        let startMillis = 0;
        let endMillis = new Date().getTime(); 
        if (startDate) {
            const sDate = new Date(startDate);
            sDate.setHours(0, 0, 0, 0);
            startMillis = sDate.getTime();
        }
        if (endDate) {
            const eDate = new Date(endDate);
            eDate.setHours(23, 59, 59, 999);
            endMillis = eDate.getTime();
        }
        if (startDate && endDate && startMillis > endMillis) {
            return res.status(400).json({ error: "Data de início não pode ser posterior à data de fim." });
        }
        const totalLeadsResult = await neo4jSession.run('MATCH (l:Lead) RETURN count(l) AS totalLeads');
        const totalLeads = totalLeadsResult.records[0] ? neo4j.integer.toNumber(totalLeadsResult.records[0].get('totalLeads')) : 0;
        const totalConvertidosResult = await neo4jSession.run(
            'MATCH (l:Lead {nivelDeInteresseReuniao: "agendado"}) RETURN count(l) AS totalConvertidos'
        );
        const totalConvertidos = totalConvertidosResult.records[0] ? neo4j.integer.toNumber(totalConvertidosResult.records[0].get('totalConvertidos')) : 0;
        const leadsNoPeriodoResult = await neo4jSession.run(
            `MATCH (l:Lead)
             WHERE l.dtCriacao >= $startMillis AND l.dtCriacao <= $endMillis
             RETURN count(l) AS leadsNoPeriodo`,
            { startMillis: neo4j.int(startMillis), endMillis: neo4j.int(endMillis) } // Usar neo4j.int para timestamps
        );
        const leadsAdicionadosNoPeriodo = leadsNoPeriodoResult.records[0] ? neo4j.integer.toNumber(leadsNoPeriodoResult.records[0].get('leadsNoPeriodo')) : 0;
        const convertidosNoPeriodoResult = await neo4jSession.run(
            `MATCH (l:Lead {nivelDeInteresseReuniao: "agendado"})
             WHERE l.dtUltimaAtualizacao >= $startMillis AND l.dtUltimaAtualizacao <= $endMillis // Usar dtUltimaAtualizacao para conversão no período
             RETURN count(l) AS convertidosNoPeriodo`,
            { startMillis: neo4j.int(startMillis), endMillis: neo4j.int(endMillis) }
        );
        const leadsConvertidosNoPeriodo = convertidosNoPeriodoResult.records[0] ? neo4j.integer.toNumber(convertidosNoPeriodoResult.records[0].get('convertidosNoPeriodo')) : 0;
        res.json({
            periodo: { inicio: startDate || "Início dos tempos", fim: endDate || "Agora" },
            totalLeadsGeral: totalLeads,
            totalConvertidosGeral: totalConvertidos,
            leadsAdicionadosNoPeriodo,
            leadsConvertidosNoPeriodo,
        });
    } catch (error) {
        console.error("Erro ao buscar estatísticas gerais por período:", error.message, error.stack);
        res.status(500).json({ error: "Erro ao buscar dados para estatísticas gerais por período", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/leads', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const {
            nome, tag, dor, nivelInteresse, origem,
            dtCriacaoStart, dtCriacaoEnd, dtAtualizacaoStart, dtAtualizacaoEnd,
            page = 1, limit = 10
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const params = { skip: neo4j.int(skip), limit: neo4j.int(parseInt(limit)) };
        let whereClauses = [];
        let matchClauses = ["MATCH (l:Lead)"];

        if (nome) { whereClauses.push("toLower(l.nome) CONTAINS toLower($nome)"); params.nome = nome; }
        if (nivelInteresse) { whereClauses.push("l.nivelDeInteresseReuniao = $nivelInteresse"); params.nivelInteresse = nivelInteresse; }
        if (origem) { whereClauses.push("l.origemDoLead = $origem"); params.origem = origem; }

        if (dtCriacaoStart) { const dt = new Date(dtCriacaoStart); dt.setHours(0,0,0,0); whereClauses.push("l.dtCriacao >= $dtCriacaoStartMillis"); params.dtCriacaoStartMillis = neo4j.int(dt.getTime()); }
        if (dtCriacaoEnd) { const dt = new Date(dtCriacaoEnd); dt.setHours(23,59,59,999); whereClauses.push("l.dtCriacao <= $dtCriacaoEndMillis"); params.dtCriacaoEndMillis = neo4j.int(dt.getTime()); }
        if (dtAtualizacaoStart) { const dt = new Date(dtAtualizacaoStart); dt.setHours(0,0,0,0); whereClauses.push("l.dtUltimaAtualizacao >= $dtAtualizacaoStartMillis"); params.dtAtualizacaoStartMillis = neo4j.int(dt.getTime()); }
        if (dtAtualizacaoEnd) { const dt = new Date(dtAtualizacaoEnd); dt.setHours(23,59,59,999); whereClauses.push("l.dtUltimaAtualizacao <= $dtAtualizacaoEndMillis"); params.dtAtualizacaoEndMillis = neo4j.int(dt.getTime()); }

        if (tag) { matchClauses.push("MATCH (l)-[:TEM_TAG]->(tg:Tag)"); whereClauses.push("tg.nome = $tag"); params.tag = tag; }
        if (dor) { matchClauses.push("MATCH (l)-[:TEM_DOR]->(dr:Dor)"); whereClauses.push("dr.nome = $dor"); params.dor = dor; }

        const baseQuery = `${matchClauses.join(" ")} ${whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : ""}`;
        
        const countQuery = `${baseQuery} RETURN count(DISTINCT l) AS total`;
        const countResult = await neo4jSession.run(countQuery, params);
        const totalItems = countResult.records[0] ? countResult.records[0].get('total').toNumber() : 0;
        const totalPages = Math.ceil(totalItems / parseInt(limit));

        // CORREÇÃO APLICADA AQUI:
        // O ORDER BY deve ser feito sobre o resultado do WITH DISTINCT l
        // ou sobre as propriedades do objeto retornado.
        // Vamos trazer dtUltimaAtualizacao para o WITH e ordenar por ele.
        const dataQuery = `
            ${baseQuery}
            WITH DISTINCT l
            OPTIONAL MATCH (l)-[:TEM_TAG]->(t:Tag)
            OPTIONAL MATCH (l)-[:TEM_DOR]->(d:Dor)
            WITH l, collect(DISTINCT t.nome) AS tagNames, collect(DISTINCT d.nome) AS painNames
            ORDER BY l.dtUltimaAtualizacao DESC // Ordenar aqui, antes do RETURN final
            SKIP $skip LIMIT $limit
            RETURN l {
                .idWhatsapp, 
                .nome, 
                .nomeDoNegocio,
                .tipoDeNegocio,
                .dtCriacao, 
                .dtUltimaAtualizacao,
                .nivelDeInteresseReuniao, 
                .ultimoResumoDaSituacao,
                .currentPlanName, 
                .currentPlanStep,
                tags: tagNames,
                pains: painNames
            } AS lead
        `;
        
        const result = await neo4jSession.run(dataQuery, params);
        const leads = result.records.map(record => {
            const leadData = convertNeo4jProperties(record.get('lead'));
            return {
                id: leadData.idWhatsapp,
                whatsappId: leadData.idWhatsapp,
                name: leadData.nome,
                businessName: leadData.nomeDoNegocio,
                businessType: leadData.tipoDeNegocio,
                meetingInterest: leadData.nivelDeInteresseReuniao,
                lastSummary: leadData.ultimoResumoDaSituacao,
                currentPlan: leadData.currentPlanName, 
                currentStep: leadData.currentPlanStep, 
                lastInteraction: leadData.dtUltimaAtualizacao,
                tags: leadData.tags ? leadData.tags.filter(t => t) : [], 
                pains: leadData.pains ? leadData.pains.filter(p => p) : [], 
            };
        });
        res.json({ data: leads, page: parseInt(page), limit: parseInt(limit), totalItems, totalPages });
    } catch (error) {
        console.error("Erro ao buscar lista de leads:", error.message, error.stack);
        res.status(500).json({ error: "Erro ao buscar lista de leads", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/graph/overview-formatted', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const { nodeLimit = 150, leadId } = req.query; // Adiciona filtro opcional por leadId
        let query;
        const params = { limit: neo4j.int(parseInt(nodeLimit)) };

        if (leadId) {
            query = `
                MATCH (startNode:Lead {idWhatsapp: $leadId})
                CALL apoc.path.subgraphAll(startNode, {
                    maxLevel: 2, labelFilter: '+Lead|+Dor|+Solucao|+Interesse|+PlannerHistoryEvent|+Reflection|+Hypothesis|+Message'
                })
                YIELD nodes, relationships
                UNWIND nodes AS n
                OPTIONAL MATCH (n)-[r]-(m) WHERE m IN nodes
                RETURN DISTINCT n AS node1, r AS relationship, m AS node2
                LIMIT $limit
            `;
            params.leadId = leadId;
        } else {
            query = `
                MATCH (n)
                OPTIONAL MATCH (n)-[r]-(m)
                WITH n, r, m
                LIMIT $limit 
                RETURN n AS node1, r AS relationship, m AS node2
            `;
        }
        
        const result = await neo4jSession.run(query, params);
        const nodesMap = new Map();
        const edges = [];

        result.records.forEach(record => {
            const node1 = record.get('node1');
            const relationship = record.get('relationship');
            const node2 = record.get('node2');

            [node1, node2].forEach(node => {
                if (node) {
                    const nodeId = neo4jIdToString(node.identity);
                    if (!nodesMap.has(nodeId)) {
                        const props = convertNeo4jProperties(node.properties);
                        nodesMap.set(nodeId, {
                            id: nodeId,
                            label: getNodeDisplayLabel(props, node.labels),
                            group: node.labels[0] || 'Unknown',
                            title: getNodeTitle(props, node.labels, nodeId),
                            properties: props // Adiciona todas as propriedades para possível uso no frontend
                        });
                    }
                }
            });

            if (relationship) {
                edges.push({
                    from: neo4jIdToString(relationship.start),
                    to: neo4jIdToString(relationship.end),
                    label: relationship.type,
                    title: relationship.type, // Adiciona o tipo como título para o hover
                    properties: convertNeo4jProperties(relationship.properties) // Propriedades do relacionamento
                });
            }
        });
        res.json({ nodes: Array.from(nodesMap.values()), edges });
    } catch (error) {
        console.error("Erro ao buscar dados para visão geral do grafo:", error.message, error.stack);
         if (error.message.toLowerCase().includes("unknown function 'apoc")) {
             return res.status(501).json({ error: "Funcionalidade de subgrafo (APOC) não disponível no Neo4j para filtro por lead.", details: error.message });
        }
        res.status(500).json({ error: "Erro ao buscar dados para o grafo", details: error.message });
    } finally {
        await closeSession(neo4jSession);
    }
});

// =========================================================================
// ENDPOINTS DE PERSONALIDADE DINÂMICA
// =========================================================================
const { PersonaManager: PMServer } = require('./personaManager');
const personaMgrForAPI = new PMServer();

// Listar seções de uma persona
app.get('/api/persona/:personaName/sections', async (req, res) => {
    const { personaName } = req.params;
    try {
        const session = await getSession();
        const result = await session.run(
            `MATCH (p:Persona {name:$personaName})-[:HAS_SECTION]->(s:PromptSection)
             RETURN s.sectionName AS sectionName, s.sortOrder AS sortOrder, s.version AS version,
                    substring(s.content,0,200) AS preview
             ORDER BY s.sortOrder`, { personaName });
        await session.close();
        if (result.records.length === 0) {
            return res.status(404).json({ error: 'Persona ou seções não encontradas.' });
        }
        const sections = result.records.map(r => r.toObject());
        return res.json(sections);
    } catch (err) {
        console.error('[API Persona] Erro ao listar seções:', err);
        return res.status(500).json({ error: 'Erro interno ao listar seções.' });
    }
});

// Atualizar/Inserir uma seção específica
app.put('/api/persona/:personaName/sections/:sectionName', async (req, res) => {
    const { personaName, sectionName } = req.params;
    const { content, sortOrder } = req.body;
    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'Campo "content" obrigatório.' });
    }
    try {
        await personaMgrForAPI.upsertSection(personaName, {
            sectionName,
            sortOrder: typeof sortOrder === 'number' ? sortOrder : 999,
            content
        });
        personaMgrForAPI.refresh(personaName);
        return res.json({ success: true, message: `Seção '${sectionName}' atualizada para persona '${personaName}'.` });
    } catch (err) {
        console.error('[API Persona] Erro ao atualizar seção:', err);
        return res.status(500).json({ error: 'Erro interno ao atualizar seção.' });
    }
});

// Obter prompt compilado da persona (para preview)
app.get('/api/persona/:personaName/compiled', async (req, res) => {
    const { personaName } = req.params;
    try {
        const compiled = await personaMgrForAPI.getCompiledPrompt(personaName, {
            NOME_DO_AGENTE: process.env.NOME_DO_AGENTE || 'Agente',
            DELIMITER: process.env.DELIMITER_MSG_BREAK || '||MSG_BREAK||'
        });
        if (!compiled) return res.status(404).json({ error: 'Persona não encontrada ou sem seções.' });
        return res.type('text/plain').send(compiled);
    } catch (err) {
        console.error('[API Persona] Erro ao compilar prompt:', err);
        return res.status(500).json({ error: 'Erro interno ao compilar prompt.' });
    }
});

// =========================================================================
// ENDPOINTS DE FUNIL DE MARKETING
// =========================================================================
app.get('/api/funnel/:name/stats', async (req, res) => {
  const { name } = req.params;
  try {
    const stats = await funnelManager.getFunnelMetrics(name);
    res.json(stats);
  } catch (e) {
    console.error('Erro funnel stats', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/funnel/:name/stage', async (req, res) => {
  const { name } = req.params;
  const { stageName, order = 0, goal = '', description = '' } = req.body;
  if (!stageName) return res.status(400).json({ error: 'stageName é obrigatório' });
  try {
    await funnelManager.ensureFunnel(name, [{ name: stageName, order, goal, description }]);
    res.json({ success: true });
  } catch (e) {
    console.error('Erro criar estágio funil', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// =========================================================================
// INICIALIZAÇÃO E SHUTDOWN
// =========================================================================
app.listen(PORT, () => {
    console.log(`Servidor da API da Dashboard Kora Brain rodando na porta ${PORT}`);
    getSession().then(session => {
        console.log("Conexão com Neo4j verificada com sucesso para a API da dashboard.");
        session.close();
    }).catch(err => {
        console.error("!!!!!!!!!! FALHA AO VERIFICAR CONEXÃO COM NEO4J PARA A API DA DASHBOARD !!!!!!!!!!", err.message);
    });
});

let isShuttingDown = false;
async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('Recebido sinal para encerrar a API da dashboard Kora Brain...');
    try {
        await closeDriver();
        console.log('Driver Neo4j da API da dashboard Kora Brain fechado.');
    } catch (e) {
        console.error('Erro ao fechar driver Neo4j da API Kora Brain:', e);
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error, origin) => {
  console.error(`API Dashboard Kora Brain - Exceção não capturada: ${error.message}`, error.stack, `Origem: ${origin}`);
  // Considerar um shutdown(1) para indicar erro
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('API Dashboard Kora Brain - Rejeição de Promise não tratada:', reason, 'Promise:', promise);
  // Considerar um shutdown(1)
});

// =========================================================================
// ENDPOINT PARA HOT-RELOAD DAS "MÃOS" (Ferramentas Plug-and-Play)
// =========================================================================
try {
    const { reloadHands } = require('./index');
    if (typeof reloadHands === 'function') {
        app.post('/api/hands/reload', async (req, res) => {
            try {
                const result = reloadHands();
                res.json({ success: true, ...result });
            } catch (err) {
                console.error('[Dashboard] Erro ao executar reloadHands:', err);
                res.status(500).json({ success: false, error: err.message });
            }
        });
    } else {
        console.warn('[Dashboard] reloadHands não disponível no módulo index.js. Endpoint /api/hands/reload não será registrado.');
    }
} catch (e) {
    console.warn('[Dashboard] Falha ao importar reloadHands de index.js:', e.message);
}

// ================== DASHBOARD EXTRA ENDPOINTS ==========================

// KPIs agregados simples (total leads etc.)
app.get('/api/stats/geral', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const totalLeads = (await neo4jSession.run('MATCH (l:Lead) RETURN count(l) AS total')).records[0].get('total').toNumber();
        const totalConvertidos = (await neo4jSession.run('MATCH (l:Lead {nivelDeInteresseReuniao:"agendado"}) RETURN count(l) AS total')).records[0].get('total').toNumber();
        // Leads adicionados/convertidos hoje
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        const amanha = new Date(hoje.getTime()+86400000);
        const leadsAdicionadosHoje = (await neo4jSession.run('MATCH (l:Lead) WHERE l.dtCriacao >= $hoje AND l.dtCriacao < $amanha RETURN count(l) AS c',{hoje:neo4j.int(hoje.getTime()),amanha:neo4j.int(amanha.getTime())})).records[0].get('c').toNumber();
        const leadsConvertidosHoje = (await neo4jSession.run('MATCH (l:Lead {nivelDeInteresseReuniao:"agendado"}) WHERE l.dtUltimaAtualizacao >= $hoje AND l.dtUltimaAtualizacao < $amanha RETURN count(l) AS c',{hoje:neo4j.int(hoje.getTime()),amanha:neo4j.int(amanha.getTime())})).records[0].get('c').toNumber();
        res.json({ totalLeads, totalConvertidos, leadsAdicionadosHoje, leadsConvertidosHoje });
    } catch (e){
        console.error('stats/geral err',e);
        res.status(500).json({error:'stats geral'});
    } finally { await closeSession(neo4jSession);}  
});

// Distribuição Dores
app.get('/api/stats/dores', async (req,res)=>{
    const neo4jSession=await getSession();
    try{
        const result=await neo4jSession.run('MATCH (l:Lead)-[:TEM_DOR]->(d:Dor) RETURN d.nome AS dor, count(l) AS qtd');
        res.json(result.records.map(r=>({nome:r.get('dor'),quantidade:r.get('qtd').toNumber()})));
    }catch(e){res.status(500).json({error:'stats dores'});}finally{await closeSession(neo4jSession);}  
});

// Níveis de interesse
app.get('/api/stats/niveis-interesse', async (req,res)=>{
    const neo4jSession=await getSession();
    try{
        const result=await neo4jSession.run('MATCH (l:Lead) RETURN l.nivelDeInteresseReuniao AS nivel, count(l) AS qtd');
        res.json(result.records.map(r=>({nivel:r.get('nivel')||'N/A',quantidade:r.get('qtd').toNumber()})));
    }catch(e){res.status(500).json({error:'stats nivel'});}finally{await closeSession(neo4jSession);}  
});

// Avg response time placeholder
app.get('/api/agent/avg-response-time', (_req,res)=>{
    res.json({avgResponseTimeSeconds:null,message:'não coletado'});
});

// Avg interactions
app.get('/api/agent/avg-interactions', async (req,res)=>{
    const neo4jSession=await getSession();
    try{
        const r=await neo4jSession.run('MATCH (l:Lead) WHERE l.historicoDeInteracaoResumido IS NOT NULL RETURN avg(size(l.historicoDeInteracaoResumido)) AS m');
        const v=r.records[0].get('m');
        res.json({mediaInteracoes:v?parseFloat(v):0});
    }catch(e){res.status(500).json({error:'avg interactions'});}finally{await closeSession(neo4jSession);}  
});

// Analytics overview
app.get('/api/analytics/overview-legacy', async (req,res)=>{
    const neo4jSession=await getSession();
    try{
        const refl=(await neo4jSession.run('MATCH (r:Reflection) RETURN count(r) AS c')).records[0].get('c').toNumber();
        const leads=(await neo4jSession.run('MATCH (l:Lead) RETURN count(l) AS c')).records[0].get('c').toNumber();
        const meets=(await neo4jSession.run('MATCH (l:Lead {nivelDeInteresseReuniao:"agendado"}) RETURN count(l) AS c')).records[0].get('c').toNumber();
        const plan=(await neo4jSession.run('MATCH (pe:PlannerExecution) RETURN avg(CASE pe.status WHEN "completed" THEN 1.0 ELSE 0.0 END)*100 AS a')).records[0].get('a')||65;
        res.json({totalReflections:refl,activeLeads:leads,meetingsScheduled:meets,averagePlanSuccessRate:parseFloat(Number(plan).toFixed(2))});
    }catch(e){res.status(500).json({error:'overview'});}finally{await closeSession(neo4jSession);}  
});

app.get('/api/analytics/sentiment-distribution-legacy', async (req,res)=>{
    const neo4jSession=await getSession();
    try{
        const result=await neo4jSession.run('MATCH (r:Reflection) WHERE r.sentimentoInferidoDoLead IS NOT NULL RETURN r.sentimentoInferidoDoLead AS s, count(r) AS c');
        const data=result.records.map(r=>({name:r.get('s'),value:r.get('c').toNumber()}));
        res.json(data.length?data:[{name:'Não Coletado',value:100}]);
    }catch(e){res.status(500).json({error:'sentiment'});}finally{await closeSession(neo4jSession);}  
});
