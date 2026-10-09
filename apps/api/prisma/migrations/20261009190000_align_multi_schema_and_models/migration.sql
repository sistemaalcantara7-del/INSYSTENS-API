-- ==============================================================================
-- INSYSTENS — MIGRATION: 20261009190000_align_multi_schema_and_models
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- FASE 1: PRÉ-CONDIÇÕES E VALIDAÇÕES DEFENSIVAS
-- ------------------------------------------------------------------------------

-- 1.1 Validar se PollingLocation pode ser migrada sem perda de dados não mapeados
DO '
DECLARE
    v_polling_count INTEGER;
BEGIN
    SELECT count(*) INTO v_polling_count FROM public."PollingLocation";
    IF v_polling_count > 0 THEN
        RAISE EXCEPTION ''ABORTADO: public.PollingLocation contém % registros. A transição de cityName para cityCode requer mapeamento prévio de dados.'', v_polling_count;
    END IF;
END;
';

-- 1.2 Validar se ApiKey possui registros órfãos antes de exigir accountId NOT NULL
DO '
DECLARE
    v_apikey_count INTEGER;
BEGIN
    SELECT count(*) INTO v_apikey_count FROM public."ApiKey";
    IF v_apikey_count > 0 THEN
        RAISE EXCEPTION ''ABORTADO: public.ApiKey contém % registros sem conta associada. Não é permitido criar accountId NOT NULL sem plano explícito de backfill.'', v_apikey_count;
    END IF;
END;
';

-- ------------------------------------------------------------------------------
-- FASE 2: SCHEMAS E MOVIMENTAÇÃO DE TABELAS EXISTENTES
-- ------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS "tse";
CREATE SCHEMA IF NOT EXISTS "mandato";
CREATE SCHEMA IF NOT EXISTS "analytics";

-- Mover as 6 tabelas eleitorais existentes de public para tse
ALTER TABLE public."Election" SET SCHEMA tse;
ALTER TABLE public."Candidate" SET SCHEMA tse;
ALTER TABLE public."PollingLocation" SET SCHEMA tse;
ALTER TABLE public."ElectoralSection" SET SCHEMA tse;
ALTER TABLE public."SectionVote" SET SCHEMA tse;
ALTER TABLE public."SectionElectorateProfile" SET SCHEMA tse;

-- ------------------------------------------------------------------------------
-- FASE 3: CRIAÇÃO DE TABELAS GEOGRÁFICAS OFICIAIS EM tse
-- ------------------------------------------------------------------------------

CREATE TABLE "tse"."State" (
    "uf" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "State_pkey" PRIMARY KEY ("uf")
);

CREATE TABLE "tse"."City" (
    "code" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "uf" TEXT NOT NULL,
    CONSTRAINT "City_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "City_uf_fkey" FOREIGN KEY ("uf") REFERENCES "tse"."State"("uf") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "tse"."ElectoralZone" (
    "id" TEXT NOT NULL,
    "zoneNumber" INTEGER NOT NULL,
    "cityCode" INTEGER NOT NULL,
    CONSTRAINT "ElectoralZone_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ElectoralZone_cityCode_fkey" FOREIGN KEY ("cityCode") REFERENCES "tse"."City"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ElectoralZone_zoneNumber_cityCode_key" ON "tse"."ElectoralZone"("zoneNumber", "cityCode");

-- ------------------------------------------------------------------------------
-- FASE 4: ALINHAMENTO ESTRUTURAL DE tse.PollingLocation
-- ------------------------------------------------------------------------------

DROP INDEX IF EXISTS "tse"."PollingLocation_uf_cityName_zoneNumber_locationCode_key";
DROP INDEX IF EXISTS "tse"."PollingLocation_cityName_idx";
ALTER TABLE "tse"."PollingLocation" DROP COLUMN "cityName";
ALTER TABLE "tse"."PollingLocation" ADD COLUMN "cityCode" INTEGER NOT NULL;
ALTER TABLE "tse"."PollingLocation" ADD COLUMN IF NOT EXISTS "electoralZoneId" TEXT;

ALTER TABLE "tse"."PollingLocation" ADD CONSTRAINT "PollingLocation_cityCode_fkey" FOREIGN KEY ("cityCode") REFERENCES "tse"."City"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tse"."PollingLocation" ADD CONSTRAINT "PollingLocation_electoralZoneId_fkey" FOREIGN KEY ("electoralZoneId") REFERENCES "tse"."ElectoralZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "PollingLocation_uf_cityCode_zoneNumber_locationCode_key" ON "tse"."PollingLocation"("uf", "cityCode", "zoneNumber", "locationCode");
CREATE INDEX "PollingLocation_cityCode_idx" ON "tse"."PollingLocation"("cityCode");

-- ------------------------------------------------------------------------------
-- FASE 5: TABELAS DE CONTA EM public E ALINHAMENTO DE ApiKey
-- ------------------------------------------------------------------------------

CREATE TABLE "public"."Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "ssoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Account_slug_key" ON "public"."Account"("slug");
CREATE UNIQUE INDEX "Account_ssoId_key" ON "public"."Account"("ssoId");

CREATE TABLE "public"."PoliticalProfile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "candidateName" TEXT,
    "candidateNumber" TEXT,
    "role" TEXT,
    "party" TEXT,
    "uf" TEXT,
    "cityCode" INTEGER,
    "candidateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PoliticalProfile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PoliticalProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PoliticalProfile_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "tse"."Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PoliticalProfile_accountId_key" ON "public"."PoliticalProfile"("accountId");

CREATE TABLE "public"."ElectionInterest" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "electionId" TEXT,
    "year" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ElectionInterest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ElectionInterest_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ElectionInterest_electionId_fkey" FOREIGN KEY ("electionId") REFERENCES "tse"."Election"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ElectionInterest_accountId_year_round_type_key" ON "public"."ElectionInterest"("accountId", "year", "round", "type");

CREATE TABLE "public"."AutomaticFilter" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "filterType" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AutomaticFilter_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutomaticFilter_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ApiKey (0 registros verificados): adição limpa da coluna e chave estrangeira
ALTER TABLE "public"."ApiKey" ADD COLUMN "accountId" TEXT NOT NULL;
ALTER TABLE "public"."ApiKey" ADD CONSTRAINT "ApiKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------------------
-- FASE 6: TABELAS DO MÓDULO mandato
-- ------------------------------------------------------------------------------

CREATE TABLE "mandato"."Leader" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "region" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Leader_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Leader_tenantId_idx" ON "mandato"."Leader"("tenantId");

CREATE TABLE "mandato"."RegisteredVoter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "uf" TEXT NOT NULL,
    "cityCode" INTEGER NOT NULL,
    "zoneNumber" INTEGER,
    "sectionNumber" INTEGER,
    "address" TEXT,
    "neighborhood" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "leaderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RegisteredVoter_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RegisteredVoter_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "mandato"."Leader"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "RegisteredVoter_tenantId_idx" ON "mandato"."RegisteredVoter"("tenantId");
CREATE INDEX "RegisteredVoter_uf_cityCode_idx" ON "mandato"."RegisteredVoter"("uf", "cityCode");
CREATE INDEX "RegisteredVoter_leaderId_idx" ON "mandato"."RegisteredVoter"("leaderId");
CREATE INDEX "RegisteredVoter_latitude_longitude_idx" ON "mandato"."RegisteredVoter"("latitude", "longitude");

CREATE TABLE "mandato"."SocialAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocialAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SocialAction_tenantId_idx" ON "mandato"."SocialAction"("tenantId");
CREATE INDEX "SocialAction_latitude_longitude_idx" ON "mandato"."SocialAction"("latitude", "longitude");

CREATE TABLE "mandato"."ServiceProvided" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "citizenName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "cost" DECIMAL(10,2),
    "date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "socialActionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceProvided_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ServiceProvided_socialActionId_fkey" FOREIGN KEY ("socialActionId") REFERENCES "mandato"."SocialAction"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ServiceProvided_tenantId_idx" ON "mandato"."ServiceProvided"("tenantId");

CREATE TABLE "mandato"."CitizenDemand" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CitizenDemand_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CitizenDemand_voterId_fkey" FOREIGN KEY ("voterId") REFERENCES "mandato"."RegisteredVoter"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CitizenDemand_tenantId_idx" ON "mandato"."CitizenDemand"("tenantId");
CREATE INDEX "CitizenDemand_voterId_idx" ON "mandato"."CitizenDemand"("voterId");

CREATE TABLE "mandato"."Campaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "targetGoal" TEXT,
    "budget" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Campaign_tenantId_idx" ON "mandato"."Campaign"("tenantId");

CREATE TABLE "mandato"."CampaignEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "leaderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CampaignEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CampaignEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mandato"."Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CampaignEvent_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "mandato"."Leader"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "CampaignEvent_campaignId_idx" ON "mandato"."CampaignEvent"("campaignId");
CREATE INDEX "CampaignEvent_leaderId_idx" ON "mandato"."CampaignEvent"("leaderId");
CREATE INDEX "CampaignEvent_latitude_longitude_idx" ON "mandato"."CampaignEvent"("latitude", "longitude");

-- ------------------------------------------------------------------------------
-- FASE 7: TABELAS DE MÉTRICAS TERRITORIAIS EM analytics
-- ------------------------------------------------------------------------------

CREATE TABLE "analytics"."TerritorialScore" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "uf" TEXT NOT NULL,
    "cityCode" INTEGER NOT NULL,
    "zoneNumber" INTEGER,
    "sectionNumber" INTEGER,
    "score" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER,
    "explanation" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TerritorialScore_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TerritorialScore_tenantId_idx" ON "analytics"."TerritorialScore"("tenantId");
CREATE INDEX "TerritorialScore_uf_cityCode_idx" ON "analytics"."TerritorialScore"("uf", "cityCode");

CREATE TABLE "analytics"."PerformanceByCity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "electionId" TEXT NOT NULL,
    "cityCode" INTEGER NOT NULL,
    "candidateId" TEXT NOT NULL,
    "totalVotes" INTEGER NOT NULL,
    "votePercentage" DOUBLE PRECISION NOT NULL,
    "candidateRank" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PerformanceByCity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PerformanceByCity_electionId_fkey" FOREIGN KEY ("electionId") REFERENCES "tse"."Election"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PerformanceByCity_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "tse"."Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PerformanceByCity_tenantId_idx" ON "analytics"."PerformanceByCity"("tenantId");
CREATE INDEX "PerformanceByCity_electionId_cityCode_idx" ON "analytics"."PerformanceByCity"("electionId", "cityCode");
CREATE INDEX "PerformanceByCity_candidateId_idx" ON "analytics"."PerformanceByCity"("candidateId");

CREATE TABLE "analytics"."PerformanceByPollingLocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "electionId" TEXT NOT NULL,
    "pollingLocationId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "totalVotes" INTEGER NOT NULL,
    "votePercentage" DOUBLE PRECISION NOT NULL,
    "candidateRank" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PerformanceByPollingLocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PerformanceByPollingLocation_electionId_fkey" FOREIGN KEY ("electionId") REFERENCES "tse"."Election"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PerformanceByPollingLocation_pollingLocationId_fkey" FOREIGN KEY ("pollingLocationId") REFERENCES "tse"."PollingLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PerformanceByPollingLocation_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "tse"."Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PerformanceByPollingLocation_tenantId_idx" ON "analytics"."PerformanceByPollingLocation"("tenantId");
CREATE INDEX "PerformanceByPollingLocation_electionId_pollingLocationId_idx" ON "analytics"."PerformanceByPollingLocation"("electionId", "pollingLocationId");
CREATE INDEX "PerformanceByPollingLocation_candidateId_idx" ON "analytics"."PerformanceByPollingLocation"("candidateId");

CREATE TABLE "analytics"."PerformanceBySection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "electionId" TEXT NOT NULL,
    "electoralSectionId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "totalVotes" INTEGER NOT NULL,
    "votePercentage" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PerformanceBySection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PerformanceBySection_electionId_fkey" FOREIGN KEY ("electionId") REFERENCES "tse"."Election"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PerformanceBySection_electoralSectionId_fkey" FOREIGN KEY ("electoralSectionId") REFERENCES "tse"."ElectoralSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PerformanceBySection_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "tse"."Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PerformanceBySection_tenantId_idx" ON "analytics"."PerformanceBySection"("tenantId");
CREATE INDEX "PerformanceBySection_electionId_electoralSectionId_idx" ON "analytics"."PerformanceBySection"("electionId", "electoralSectionId");
CREATE INDEX "PerformanceBySection_candidateId_idx" ON "analytics"."PerformanceBySection"("candidateId");

CREATE TABLE "analytics"."GrowthOpportunity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cityCode" INTEGER NOT NULL,
    "zoneNumber" INTEGER,
    "pollingLocationId" TEXT,
    "priorityScore" DOUBLE PRECISION NOT NULL,
    "targetAudienceSize" INTEGER NOT NULL,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GrowthOpportunity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GrowthOpportunity_tenantId_idx" ON "analytics"."GrowthOpportunity"("tenantId");
CREATE INDEX "GrowthOpportunity_cityCode_idx" ON "analytics"."GrowthOpportunity"("cityCode");

CREATE TABLE "analytics"."HeatmapPoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cityCode" INTEGER NOT NULL,
    "zoneNumber" INTEGER,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "metricType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HeatmapPoint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HeatmapPoint_tenantId_idx" ON "analytics"."HeatmapPoint"("tenantId");
CREATE INDEX "HeatmapPoint_cityCode_idx" ON "analytics"."HeatmapPoint"("cityCode");
CREATE INDEX "HeatmapPoint_latitude_longitude_idx" ON "analytics"."HeatmapPoint"("latitude", "longitude");

CREATE TABLE "analytics"."AiStrategyReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "priorityScore" DOUBLE PRECISION,
    "recommendations" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiStrategyReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiStrategyReport_tenantId_idx" ON "analytics"."AiStrategyReport"("tenantId");

COMMIT;
