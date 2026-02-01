// SummaryBudget.jsx
import React, { useEffect, useState, useMemo } from 'react';
import { useLocation, Link } from 'react-router-dom';
import axios from 'axios';
import {
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell,
    Legend,
    Tooltip as RechartsTooltip,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
} from 'recharts';

/**
 * Given period like "11-2025", returns number of open school days in that month.
 * Open day = any calendar day that is NOT Friday.
 */
function getOpenSchoolDaysForPeriod(periodStr) {
    if (!periodStr || typeof periodStr !== 'string') return 0;
    const parts = periodStr.split('-');
    if (parts.length !== 2) return 0;

    const mm = Number(parts[0]);
    const yyyy = Number(parts[1]);
    if (!Number.isFinite(mm) || !Number.isFinite(yyyy)) return 0;

    const daysInMonth = new Date(yyyy, mm, 0).getDate();
    let openDays = 0;

    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(yyyy, mm - 1, d);
        const weekday = date.getDay(); // 0=Sun ... 5=Fri
        if (weekday !== 5) {
            openDays++;
        }
    }

    return openDays;
}

function SummaryBudget() {
    const [summaryData, setSummaryData] = useState([]);
    const [prevSummaryData, setPrevSummaryData] = useState([]);
    const [modalAccount, setModalAccount] = useState(null);
    const [modalGroup, setModalGroup] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [templateLoading, setTemplateLoading] = useState(false);
    const [accountGuideMap, setAccountGuideMap] = useState({});
    const [groupsList, setGroupsList] = useState([]);
    const [expandedGroups, setExpandedGroups] = useState({});

    // NEW: for nutrition/kcal per school
    const [nutritionData, setNutritionData] = useState([]);
    const [nutritionOverall, setNutritionOverall] = useState(null);
    const [nutritionLoading, setNutritionLoading] = useState(false);

    // main selector in top bar
    // 'period' | 'cumulative' | 'nutrition'
    const [tableMode, setTableMode] = useState('period');

    const location = useLocation();
    const { period } = location.state || {};
    const LS_KEY = 'summaryBudgetExpandedGroups';

    const months = useMemo(
        () => [
            'January',
            'February',
            'March',
            'April',
            'May',
            'June',
            'July',
            'August',
            'September',
            'October',
            'November',
            'December',
        ],
        []
    );

    function parsePeriod(p) {
        if (!p || typeof p !== 'string') return null;
        const s = p.trim();
        let m = s.match(/^(\d{4})[^\d]?(\d{1,2})$/);
        if (m) return { year: Number(m[1]), monthIdx: Number(m[2]) - 1 };
        m = s.match(/^(\d{1,2})[^\d]?(\d{4})$/);
        if (m) return { year: Number(m[2]), monthIdx: Number(m[1]) - 1 };
        m = s.match(/^([A-Za-z]+)[\s\-\/]+(\d{4})$/);
        if (m) {
            const name = m[1].toLowerCase();
            const idx = months.findIndex((x) =>
                x.toLowerCase().startsWith(name.slice(0, 3))
            );
            if (idx >= 0) return { year: Number(m[2]), monthIdx: idx };
        }
        return null;
    }

    const now = useMemo(() => new Date(), []);
    const currentYear = now.getFullYear();

    const parsed = useMemo(() => parsePeriod(period), [period, months]);
    const [selectedYear, setSelectedYear] = useState(
        parsed ? parsed.year : currentYear
    );
    const [selectedMonth, setSelectedMonth] = useState(
        parsed
            ? months[Math.max(0, Math.min(11, parsed.monthIdx))]
            : months[now.getMonth()]
    );

    // right card tabs: only pie + graph now
    const [activeTab, setActiveTab] = useState('pie');

    const selectedPeriod = useMemo(() => {
        const monthIdx = months.findIndex((m) => m === selectedMonth);
        const mm = String(
            monthIdx >= 0 ? monthIdx + 1 : now.getMonth() + 1
        ).padStart(2, '0');
        return `${mm}-${selectedYear}`;
    }, [months, selectedMonth, selectedYear, now]);

    const selectedMonthIdx = useMemo(() => {
        const idx = months.findIndex((m) => m === selectedMonth);
        return idx >= 0 ? idx : 11;
    }, [months, selectedMonth]);

    // NEW: how many open days in this selected month (exclude Fridays)
    const daysInPeriod = useMemo(
        () => getOpenSchoolDaysForPeriod(selectedPeriod),
        [selectedPeriod]
    );

    useEffect(() => {
        const p = parsePeriod(period);
        if (p) {
            if (p.year !== selectedYear) setSelectedYear(p.year);
            const name = months[Math.max(0, Math.min(11, p.monthIdx))];
            if (name && name !== selectedMonth) setSelectedMonth(name);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [period]);

    // load expanded groups from LS
    useEffect(() => {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) {
                const parsedLS = JSON.parse(raw);
                if (parsedLS && typeof parsedLS === 'object') setExpandedGroups(parsedLS);
            }
        } catch (err) {
            console.warn('Failed to load expanded groups from localStorage', err);
        }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(expandedGroups));
        } catch (err) {
            console.warn('Failed to save expanded groups to localStorage', err);
        }
    }, [expandedGroups]);

    // fetch current period (MM-YYYY)
    useEffect(() => {
        const usePeriod = parsed
            ? `${parsed.year}-${String(parsed.monthIdx + 1).padStart(2, '0')}`
            : null;
        const sendingPeriod =
            usePeriod === selectedPeriod && period ? period : selectedPeriod;

        async function fetchSummary() {
            try {
                setIsLoading(true);
                const res = await axios.get(
                    `/summary-budget?period=${encodeURIComponent(sendingPeriod)}`
                );
                setSummaryData(res.data || []);
            } catch (err) {
                console.error('Error fetching summary budget:', err);
                setSummaryData([]);
            } finally {
                setIsLoading(false);
            }
        }
        fetchSummary();
    }, [selectedPeriod, period, parsed]);

    // previous period for change column
    const prevPeriod = useMemo(() => {
        const [mmStr, yyyyStr] = selectedPeriod.split('-');
        const mm = Number(mmStr);
        let y = Number(yyyyStr);
        let mIdx = mm - 1 - 1;
        if (mIdx < 0) {
            mIdx = 11;
            y = y - 1;
        }
        const mmPrev = String(mIdx + 1).padStart(2, '0');
        return `${mmPrev}-${y}`;
    }, [selectedPeriod]);

    useEffect(() => {
        async function fetchPrev() {
            try {
                const res = await axios.get(
                    `/summary-budget?period=${encodeURIComponent(prevPeriod)}`
                );
                setPrevSummaryData(res.data || []);
            } catch (err) {
                console.error('Error fetching previous summary budget:', err);
                setPrevSummaryData([]);
            }
        }
        fetchPrev();
    }, [prevPeriod]);

    // manual template
    useEffect(() => {
        async function fetchTemplate() {
            try {
                setTemplateLoading(true);
                const res = await axios.get('/manual-klavuz-template');
                const { groups = [], accountGuide = [] } = res.data || {};
                const guideMap = {};
                accountGuide.forEach((item) => {
                    guideMap[Number(item.accountId)] = {
                        accountId: Number(item.accountId),
                        accountName: item.accountName,
                        groupId: item.groupId !== null ? Number(item.groupId) : null,
                        groupName: item.groupName || null,
                    };
                });
                setAccountGuideMap(guideMap);
                setGroupsList(groups || []);
            } catch (err) {
                console.error('Failed to fetch manual klavuz template:', err);
                setAccountGuideMap({});
                setGroupsList([]);
            } finally {
                setTemplateLoading(false);
            }
        }
        fetchTemplate();
    }, []);

    // YEAR breakdown (for graph + cumulative table/top)
    const [breakdownPayload, setBreakdownPayload] = useState({
        year: null,
        months: [],
        accounts: [],
        schools: [],
    });
    const [chartScope, setChartScope] = useState('overall');
    const [selectedAccountId, setSelectedAccountId] = useState(null);
    const [selectedSchoolId, setSelectedSchoolId] = useState(null);

    useEffect(() => {
        let mounted = true;
        async function fetchBreakdown(year) {
            if (!year) {
                setBreakdownPayload({ year: null, months: [], accounts: [], schools: [] });
                return;
            }
            try {
                const res = await axios.get(
                    `/summary-budget/graph-data?year=${encodeURIComponent(year)}`
                );
                const payload = res.data || {};
                const monthsResp = payload.months || [];
                const accountsResp = payload.accounts || [];
                const schoolsResp = payload.schools || [];

                const normalizeMonthlyWithLimit = (monthlyArr) =>
                    Array.from({ length: 12 }, (_, i) => {
                        const found = (monthlyArr || []).find((m) => Number(m.month) === i + 1);
                        if (i > selectedMonthIdx) {
                            return { month: i + 1, asked: null, approved: null };
                        }
                        return {
                            month: i + 1,
                            asked: found ? Number(found.asked) || 0 : 0,
                            approved: found ? Number(found.approved) || 0 : 0,
                        };
                    });

                const monthsNormalized = normalizeMonthlyWithLimit(monthsResp);
                const accountsNormalized = (accountsResp || []).map((a) => ({
                    account_id: a.account_id,
                    account_name: a.account_name || `Account ${a.account_id}`,
                    totalAsked: Number(a.totalAsked || 0),
                    totalApproved: Number(a.totalApproved || 0),
                    monthly: normalizeMonthlyWithLimit(a.monthly || []),
                }));
                const schoolsNormalized = (schoolsResp || []).map((s) => ({
                    school_id: s.school_id,
                    school_name: s.school_name || `School ${s.school_id}`,
                    totalAsked: Number(s.totalAsked || 0),
                    totalApproved: Number(s.totalApproved || 0),
                    monthly: normalizeMonthlyWithLimit(s.monthly || []),
                }));

                if (mounted) {
                    setBreakdownPayload({
                        year: payload.year || String(year),
                        months: monthsNormalized,
                        accounts: accountsNormalized,
                        schools: schoolsNormalized,
                    });

                    if (!selectedAccountId && accountsNormalized.length > 0) {
                        const topAcc = accountsNormalized
                            .slice()
                            .sort((x, y) => y.totalAsked - x.totalAsked)[0];
                        setSelectedAccountId(topAcc.account_id);
                    }
                    if (!selectedSchoolId && schoolsNormalized.length > 0) {
                        const topSch = schoolsNormalized
                            .slice()
                            .sort((x, y) => y.totalAsked - x.totalAsked)[0];
                        setSelectedSchoolId(topSch.school_id);
                    }
                }
            } catch (err) {
                console.error('Error fetching breakdown graph data:', err);
                if (mounted) {
                    setBreakdownPayload({
                        year,
                        months: Array.from({ length: 12 }, (_, i) => ({
                            month: i + 1,
                            asked: i > selectedMonthIdx ? null : 0,
                            approved: i > selectedMonthIdx ? null : 0,
                        })),
                        accounts: [],
                        schools: [],
                    });
                }
            }
        }

        fetchBreakdown(selectedYear);
        return () => {
            mounted = false;
        };
    }, [selectedYear, selectedMonthIdx, selectedAccountId, selectedSchoolId]);

    // ensure selections for scope
    useEffect(() => {
        if (chartScope === 'account') {
            if (!selectedAccountId && breakdownPayload.accounts.length > 0) {
                setSelectedAccountId(breakdownPayload.accounts[0].account_id);
            }
        } else if (chartScope === 'school') {
            if (!selectedSchoolId && breakdownPayload.schools.length > 0) {
                setSelectedSchoolId(breakdownPayload.schools[0].school_id);
            }
        }
    }, [chartScope, breakdownPayload, selectedAccountId, selectedSchoolId]);

    // NEW: fetch nutrition per school (on demand when tab is 'nutrition')
    useEffect(() => {
        if (tableMode !== 'nutrition') return;

        const usePeriod = parsed
            ? `${parsed.year}-${String(parsed.monthIdx + 1).padStart(2, '0')}`
            : null;
        const sendingPeriod =
            usePeriod === selectedPeriod && period ? period : selectedPeriod;

        async function fetchNutrition() {
            try {
                setNutritionLoading(true);
                const res = await axios.get(
                    `/summary-budget/nutrition?period=${encodeURIComponent(sendingPeriod)}`
                );
                const payload = res.data || {};
                console.log('payload:', payload);
                setNutritionData(Array.isArray(payload.schools) ? payload.schools : []);
                setNutritionOverall(payload.overall || null);
            } catch (err) {
                console.error('Error fetching nutrition summary:', err);
                setNutritionData([]);
                setNutritionOverall(null);
            } finally {
                setNutritionLoading(false);
            }
        }

        fetchNutrition();
    }, [tableMode, selectedPeriod, period, parsed]);

    // helper to build cumulative array from monthly
    const buildCumulativeFromMonthly = (monthlyArr, shortNames) => {
        let cumAsked = 0;
        let cumApproved = 0;
        return (monthlyArr || []).map((m, idx) => {
            if (m.asked === null || idx > selectedMonthIdx) {
                return { name: shortNames[idx], asked: null, approved: null };
            }
            cumAsked += Number(m.asked || 0);
            cumApproved += Number(m.approved || 0);
            return {
                name: shortNames[idx],
                asked: cumAsked,
                approved: cumApproved,
            };
        });
    };

    // GRAPH DATA (reacts to tableMode)
    const graphData = useMemo(() => {
        const shortNames = [
            'Jan',
            'Feb',
            'Mar',
            'Apr',
            'May',
            'Jun',
            'Jul',
            'Aug',
            'Sep',
            'Oct',
            'Nov',
            'Dec',
        ];

        if (tableMode === 'nutrition') {
            return [];
        }

        if (tableMode === 'period') {
            if (chartScope === 'overall') {
                const monthsArr = breakdownPayload.months || [];
                return shortNames.map((short, i) => {
                    const g = monthsArr[i] || { asked: 0, approved: 0 };
                    return {
                        name: short,
                        asked: g.asked === null ? null : Number(g.asked || 0),
                        approved: g.approved === null ? null : Number(g.approved || 0),
                    };
                });
            }

            if (chartScope === 'account') {
                const acc = (breakdownPayload.accounts || []).find(
                    (a) => String(a.account_id) === String(selectedAccountId)
                );
                if (!acc) {
                    return shortNames.map((short, i) => {
                        const isFuture = i > selectedMonthIdx;
                        return {
                            name: short,
                            asked: isFuture ? null : 0,
                            approved: isFuture ? null : 0,
                        };
                    });
                }
                return acc.monthly.map((m) => ({
                    name: shortNames[m.month - 1],
                    asked: m.asked === null ? null : Number(m.asked || 0),
                    approved: m.approved === null ? null : Number(m.approved || 0),
                }));
            }

            if (chartScope === 'school') {
                const sch = (breakdownPayload.schools || []).find(
                    (s) => String(s.school_id) === String(selectedSchoolId)
                );
                if (!sch) {
                    return shortNames.map((short, i) => {
                        const isFuture = i > selectedMonthIdx;
                        return {
                            name: short,
                            asked: isFuture ? null : 0,
                            approved: isFuture ? null : 0,
                        };
                    });
                }
                return sch.monthly.map((m) => ({
                    name: shortNames[m.month - 1],
                    asked: m.asked === null ? null : Number(m.asked || 0),
                    approved: m.approved === null ? null : Number(m.approved || 0),
                }));
            }
        }

        if (tableMode === 'cumulative') {
            if (chartScope === 'overall') {
                return buildCumulativeFromMonthly(breakdownPayload.months, shortNames);
            }

            if (chartScope === 'account') {
                const acc = (breakdownPayload.accounts || []).find(
                    (a) => String(a.account_id) === String(selectedAccountId)
                );
                if (!acc) {
                    return shortNames.map((short, i) => ({
                        name: short,
                        asked: i > selectedMonthIdx ? null : 0,
                        approved: i > selectedMonthIdx ? null : 0,
                    }));
                }
                return buildCumulativeFromMonthly(acc.monthly, shortNames);
            }

            if (chartScope === 'school') {
                const sch = (breakdownPayload.schools || []).find(
                    (s) => String(s.school_id) === String(selectedSchoolId)
                );
                if (!sch) {
                    return shortNames.map((short, i) => ({
                        name: short,
                        asked: i > selectedMonthIdx ? null : 0,
                        approved: i > selectedMonthIdx ? null : 0,
                    }));
                }
                return buildCumulativeFromMonthly(sch.monthly, shortNames);
            }
        }

        return [];
    }, [
        tableMode,
        chartScope,
        breakdownPayload,
        selectedAccountId,
        selectedSchoolId,
        selectedMonthIdx,
    ]);

    // tooltip
    const tooltipFormatter = (value, name) => {
        if (value === null || value === undefined) return ['—', name];
        return [
            Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 }),
            name,
        ];
    };

    // PERIOD aggregations
    const accountsTotal = useMemo(() => {
        return summaryData.reduce((acc, row) => {
            const key = row.account_id;
            if (!acc[key])
                acc[key] = {
                    account_id: row.account_id,
                    account_name: row.account_name,
                    asked: 0,
                    approved: 0,
                    schoolBreakdown: [],
                };
            const asked = parseFloat(row.asked) || 0;
            const approved = parseFloat(row.approved) || 0;
            acc[key].asked += asked;
            acc[key].approved += approved;
            acc[key].schoolBreakdown.push({
                school_id: row.school_id,
                school_name: row.school_name,
                asked,
                approved,
            });
            return acc;
        }, {});
    }, [summaryData]);

    const accountsTotalPrev = useMemo(() => {
        return prevSummaryData.reduce((acc, row) => {
            const key = row.account_id;
            if (!acc[key])
                acc[key] = {
                    account_id: row.account_id,
                    account_name: row.account_name,
                    asked: 0,
                    approved: 0,
                };
            const asked = parseFloat(row.asked) || 0;
            const approved = parseFloat(row.approved) || 0;
            acc[key].asked += asked;
            acc[key].approved += approved;
            return acc;
        }, {});
    }, [prevSummaryData]);

    const accountList = useMemo(
        () => Object.values(accountsTotal).sort((a, b) => b.asked - a.asked),
        [accountsTotal]
    );

    // PERIOD grouped
    const groupedData = useMemo(() => {
        const map = {};
        (groupsList || []).forEach((g) => {
            map[String(g.id)] = {
                groupId: Number(g.id),
                groupName: g.group_level_name,
                accounts: [],
                asked: 0,
                approved: 0,
                prevAsked: 0,
                prevApproved: 0,
            };
        });
        map['ungrouped'] = {
            groupId: null,
            groupName: 'Ungrouped',
            accounts: [],
            asked: 0,
            approved: 0,
            prevAsked: 0,
            prevApproved: 0,
        };

        accountList.forEach((acc) => {
            const aid = Number(acc.account_id);
            const guide = accountGuideMap[aid];
            const gid = guide && guide.groupId !== null ? String(guide.groupId) : 'ungrouped';
            if (!map[gid]) {
                map[gid] = {
                    groupId: guide && guide.groupId ? Number(guide.groupId) : null,
                    groupName:
                        guide && guide.groupName
                            ? guide.groupName
                            : gid === 'ungrouped'
                                ? 'Ungrouped'
                                : `Group ${gid}`,
                    accounts: [],
                    asked: 0,
                    approved: 0,
                    prevAsked: 0,
                    prevApproved: 0,
                };
            }
            map[gid].accounts.push(acc);
            map[gid].asked += acc.asked;
            map[gid].approved += acc.approved;

            const prevAcc = accountsTotalPrev[aid];
            map[gid].prevAsked += prevAcc ? prevAcc.asked : 0;
            map[gid].prevApproved += prevAcc ? prevAcc.approved : 0;
        });

        const ordered = [];
        (groupsList || []).forEach((g) => {
            const item = map[String(g.id)];
            if (item) ordered.push(item);
        });
        Object.keys(map).forEach((k) => {
            if (k === 'ungrouped') return;
            if (!ordered.find((x) => String(x.groupId) === k)) ordered.push(map[k]);
        });
        ordered.push(map['ungrouped']);
        return ordered;
    }, [accountList, accountGuideMap, groupsList, accountsTotalPrev]);

    // CUMULATIVE grouped (for left table & for pie when cumulative)
    const groupedDataCumulative = useMemo(() => {
        if (!breakdownPayload.accounts || breakdownPayload.accounts.length === 0)
            return groupedData;

        const base = {};
        (groupsList || []).forEach((g) => {
            base[String(g.id)] = {
                groupId: Number(g.id),
                groupName: g.group_level_name,
                accounts: [],
                asked: 0,
                approved: 0,
                prevAsked: 0,
                prevApproved: 0,
            };
        });
        base['ungrouped'] = {
            groupId: null,
            groupName: 'Ungrouped',
            accounts: [],
            asked: 0,
            approved: 0,
            prevAsked: 0,
            prevApproved: 0,
        };

        (breakdownPayload.accounts || []).forEach((acc) => {
            const aid = Number(acc.account_id);
            const guide = accountGuideMap[aid];
            const gid = guide && guide.groupId !== null ? String(guide.groupId) : 'ungrouped';
            if (!base[gid]) {
                base[gid] = {
                    groupId: guide && guide.groupId ? Number(guide.groupId) : null,
                    groupName:
                        guide && guide.groupName
                            ? guide.groupName
                            : gid === 'ungrouped'
                                ? 'Ungrouped'
                                : `Group ${gid}`,
                    accounts: [],
                    asked: 0,
                    approved: 0,
                    prevAsked: 0,
                    prevApproved: 0,
                };
            }

            let cumAsked = 0;
            let cumApproved = 0;
            let prevCumAsked = 0;
            let prevCumApproved = 0;
            (acc.monthly || []).forEach((m) => {
                const idx = Number(m.month) - 1;
                if (idx <= selectedMonthIdx) {
                    cumAsked += Number(m.asked || 0);
                    cumApproved += Number(m.approved || 0);
                }
                if (idx <= selectedMonthIdx - 1) {
                    prevCumAsked += Number(m.asked || 0);
                    prevCumApproved += Number(m.approved || 0);
                }
            });

            base[gid].accounts.push({
                account_id: aid,
                account_name: acc.account_name,
                asked: cumAsked,
                approved: cumApproved,
            });
            base[gid].asked += cumAsked;
            base[gid].approved += cumApproved;
            base[gid].prevAsked += prevCumAsked;
            base[gid].prevApproved += prevCumApproved;
        });

        const ordered = [];
        (groupsList || []).forEach((g) => {
            const item = base[String(g.id)];
            if (item) ordered.push(item);
        });
        Object.keys(base).forEach((k) => {
            if (k === 'ungrouped') return;
            if (!ordered.find((x) => String(x.groupId) === k)) ordered.push(base[k]);
        });
        ordered.push(base['ungrouped']);
        return ordered;
    }, [
        breakdownPayload,
        accountGuideMap,
        groupsList,
        selectedMonthIdx,
        groupedData,
    ]);

    const totalAsked = accountList.reduce((sum, acc) => sum + acc.asked, 0);
    const totalApproved = accountList.reduce((sum, acc) => sum + acc.approved, 0);
    const formatNumber = (num) =>
        Number(num).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const anyLoading =
        isLoading || templateLoading || (tableMode === 'nutrition' && nutritionLoading);

    const totalNutritionEaters = useMemo(
        () =>
            (nutritionData || []).reduce(
                (sum, row) => sum + (Number(row.eatingNumber) || 0),
                0
            ),
        [nutritionData]
    );

    // overall totals for nutrition footer
    const overallTotalKcalMonth = nutritionOverall?.totalKcalMonth ?? 0;
    const overallTotalEaters = totalNutritionEaters;

    const overallKcalPerPersonMonth =
        overallTotalKcalMonth > 0 && overallTotalEaters > 0
            ? overallTotalKcalMonth / overallTotalEaters
            : null;

    const overallKcalPerPersonDay =
        overallKcalPerPersonMonth != null && daysInPeriod > 0
            ? overallKcalPerPersonMonth / daysInPeriod
            : null;

    // PIE reacts to tableMode
    const pieData = useMemo(() => {
        if (tableMode === 'nutrition') return [];
        const source = tableMode === 'cumulative' ? groupedDataCumulative : groupedData;
        return source
            .filter((g) => g.groupId !== null)
            .map((g) => ({ name: g.groupName, value: Math.max(0, g.asked) }));
    }, [tableMode, groupedData, groupedDataCumulative]);

    const COLORS = [
        '#4F46E5',
        '#06B6D4',
        '#F59E0B',
        '#EF4444',
        '#10B981',
        '#8B5CF6',
        '#F97316',
        '#3B82F6',
    ];

    const top3Set = useMemo(() => {
        if (!pieData || pieData.length === 0) return new Set();
        const sorted = pieData
            .map((d, i) => ({ i, v: Number(d.value) || 0 }))
            .sort((a, b) => b.v - a.v)
            .slice(0, 3)
            .map((x) => x.i);
        return new Set(sorted);
    }, [pieData]);

    const readableTextColor = (hex) => {
        const h = hex.replace('#', '');
        const r = parseInt(h.substring(0, 2), 16);
        const g = parseInt(h.substring(2, 4), 16);
        const b = parseInt(h.substring(4, 6), 16);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness > 180 ? '#111827' : '#ffffff';
    };

    const labelRenderer = (props) => {
        const { cx, cy, midAngle, innerRadius, outerRadius, percent, index } = props;
        if (!top3Set.has(index)) return null;
        const RADIAN = Math.PI / 180;
        const r = innerRadius + (outerRadius - innerRadius) * 0.5;
        const x = cx + r * Math.cos(-midAngle * RADIAN);
        const y = cy + r * Math.sin(-midAngle * RADIAN);
        const sliceColor = COLORS[index % COLORS.length] || '#111827';
        const fill = readableTextColor(sliceColor);
        return (
            <text
                x={x}
                y={y}
                fill={fill}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={12}
                fontWeight={700}
            >
                {`${Math.round(percent * 100)}%`}
            </text>
        );
    };

    const formatChange = (current, prev) => {
        if (!prev || prev === 0) return '—';
        const pct = ((current - prev) / prev) * 100;
        const sign = pct > 0 ? '+' : '';
        return `${sign}${pct.toFixed(1)}%`;
    };

    const accountOptions = useMemo(
        () =>
            (breakdownPayload.accounts || []).map((a) => ({
                id: a.account_id,
                label: `${a.account_name} — ${formatNumber(a.totalAsked)}`,
            })),
        [breakdownPayload]
    );

    const schoolOptions = useMemo(
        () =>
            (breakdownPayload.schools || []).map((s) => ({
                id: s.school_id,
                label: `${s.school_name} — ${formatNumber(s.totalAsked)}`,
            })),
        [breakdownPayload]
    );

    // TOP ACCOUNTS also reacts to tableMode
    const topAccountsData = useMemo(() => {
        if (tableMode === 'period') {
            const total = accountList.reduce((sum, a) => sum + a.asked, 0);
            return {
                totalAsked: total,
                rows: accountList,
            };
        }

        if (tableMode === 'nutrition') {
            return {
                totalAsked: 0,
                rows: [],
            };
        }

        const rows = (breakdownPayload.accounts || []).map((acc) => {
            let cumAsked = 0;
            (acc.monthly || []).forEach((m, idx) => {
                if (m.asked === null || idx > selectedMonthIdx) return;
                cumAsked += Number(m.asked || 0);
            });
            return {
                account_id: acc.account_id,
                account_name: acc.account_name,
                asked: cumAsked,
            };
        });
        rows.sort((a, b) => b.asked - a.asked);
        const total = rows.reduce((sum, r) => sum + r.asked, 0);
        return {
            totalAsked: total,
            rows,
        };
    }, [tableMode, accountList, breakdownPayload, selectedMonthIdx]);

    // open group breakdown
    const openGroupBreakdown = (group) => {
        const hasSchoolBreakdowns = (group.accounts || []).some((a) =>
            Array.isArray(a.schoolBreakdown)
        );

        let sourceGroup = group;
        if (!hasSchoolBreakdowns) {
            const match = groupedData.find(
                (g) =>
                    (g.groupId !== null && g.groupId === group.groupId) ||
                    (g.groupId === null && group.groupId === null)
            );
            if (match) sourceGroup = match;
        }

        const schoolMap = {};
        (sourceGroup.accounts || []).forEach((acc) => {
            (acc.schoolBreakdown || []).forEach((s) => {
                const key = s.school_id ?? 'null';
                if (!schoolMap[key]) {
                    schoolMap[key] = {
                        school_id: s.school_id,
                        school_name: s.school_name,
                        asked: 0,
                        approved: 0,
                    };
                }
                schoolMap[key].asked += Number(s.asked || 0);
                schoolMap[key].approved += Number(s.approved || 0);
            });
        });

        const rows = Object.values(schoolMap).sort((a, b) => b.asked - a.asked);
        setModalGroup({
            groupName: sourceGroup.groupName,
            rows,
        });
    };

    return (
        <div className="h-screen flex flex-col overflow-hidden p-6 bg-gradient-to-br from-slate-100 via-slate-50 to-slate-200/40 relative">
            {/* soft accent blobs behind */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute -top-24 -right-10 w-72 h-72 bg-blue-200/30 blur-3xl rounded-full" />
                <div className="absolute bottom-10 -left-16 w-72 h-72 bg-emerald-200/25 blur-3xl rounded-full" />
            </div>

            {/* TOP BAR */}
            <div className="flex items-center justify-between mb-6 gap-4 relative z-10">
                {/* back */}
                <Link
                    to="/budgets/BudgetApproveCoordinator"
                    className="whitespace-nowrap rounded-full border border-blue-500/70 px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-[0_8px_26px_rgba(37,99,235,0.35)] inline-flex items-center transition-all duration-150"
                >
                    <span className="mr-2">←</span>
                    Back
                </Link>

                {/* middle: period / cumulative / nutrition */}
                <div className="flex items-center gap-2 bg-white/60 backdrop-blur-sm rounded-full px-1 py-1 shadow-sm border border-slate-100/60">
                    <button
                        onClick={() => setTableMode('period')}
                        className={`px-3 py-1 text-xs rounded-full border transition-all duration-150 ${tableMode === 'period'
                                ? 'bg-blue-600 text-white border-blue-600 shadow-[0_8px_20px_rgba(37,99,235,0.35)]'
                                : 'bg-white/70 text-gray-700 hover:bg-gray-100/80 border-transparent'
                            }`}
                    >
                        This period
                    </button>
                    <button
                        onClick={() => setTableMode('cumulative')}
                        className={`px-3 py-1 text-xs rounded-full border transition-all duration-150 ${tableMode === 'cumulative'
                                ? 'bg-blue-600 text-white border-blue-600 shadow-[0_8px_20px_rgba(37,99,235,0.35)]'
                                : 'bg-white/70 text-gray-700 hover:bg-gray-100/80 border-transparent'
                            }`}
                    >
                        Year cumulative
                    </button>
                    <button
                        onClick={() => setTableMode('nutrition')}
                        className={`px-3 py-1 text-xs rounded-full border transition-all duration-150 ${tableMode === 'nutrition'
                                ? 'bg-amber-500 text-white border-amber-500 shadow-[0_8px_20px_rgba(245,158,11,0.35)]'
                                : 'bg-white/70 text-gray-700 hover:bg-gray-100/80 border-transparent'
                            }`}
                    >
                        Nutrition / kcal
                    </button>
                </div>

                {/* right: year + months */}
                <div className="rounded-2xl border border-indigo-100/70 bg-white/70 backdrop-blur-sm p-1 shadow-[0_12px_30px_rgba(15,23,42,0.08)]">
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
                            <select
                                className="whitespace-nowrap rounded-full border px-3 py-1 text-sm bg-white/80 text-gray-700 hover:bg-gray-50 border-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                value={selectedYear}
                                onChange={(e) => setSelectedYear(Number(e.target.value))}
                            >
                                {(() => {
                                    const y = now.getFullYear();
                                    const range = [];
                                    for (let i = y - 3; i <= y + 1; i++) range.push(i);
                                    return range.map((yy) => (
                                        <option key={yy} value={yy}>
                                            {yy}
                                        </option>
                                    ));
                                })()}
                            </select>
                            {months.map((m) => (
                                <button
                                    key={m}
                                    onClick={() => setSelectedMonth(m)}
                                    className={[
                                        'whitespace-nowrap rounded-full border px-3 py-1 text-sm transition-all duration-150',
                                        selectedMonth === m
                                            ? 'bg-blue-600 text-white border-blue-600 shadow-[0_6px_20px_rgba(37,99,235,0.35)] scale-[1.01]'
                                            : 'bg-white/70 text-gray-700 hover:bg-gray-50 border-gray-200',
                                    ].join(' ')}
                                >
                                    {m}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex gap-4 flex-1 overflow-hidden relative z-10">
                {/* LEFT TABLE */}
                <div className="w-3/5 relative bg-white/85 backdrop-blur-sm rounded-2xl shadow-[0_18px_40px_rgba(15,23,42,0.08)] border border-slate-100/90 flex flex-col hover:shadow-[0_26px_55px_rgba(15,23,42,0.09)] transition-shadow duration-200">
                    {anyLoading && (
                        <div className="absolute inset-0 flex items-center justify-center bg-white/70 z-10 rounded-2xl">
                            <span className="text-gray-500 text-lg font-medium">Loading...</span>
                        </div>
                    )}

                    {/* NORMAL + CUMULATIVE TABLE */}
                    {tableMode !== 'nutrition' ? (
                        <>
                            <div className="overflow-auto flex-1 rounded-2xl">
                                <table className="min-w-full divide-y divide-gray-200 text-sm">
                                    <thead className="bg-white-500 sticky top-0 z-10">
                                        <tr>
                                            <th className="px-4 py-3 text-left text-gray-700 font-semibold">
                                                Group
                                            </th>
                                            <th className="px-4 py-3 text-center text-gray-700 font-semibold">
                                                # Accounts
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                {tableMode === 'cumulative' ? 'Asked (YTD)' : 'Asked'}
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                {tableMode === 'cumulative' ? 'Approved (YTD)' : 'Approved'}
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                {tableMode === 'cumulative'
                                                    ? 'Change (vs prev month)'
                                                    : 'Change'}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-100">
                                        {(tableMode === 'cumulative'
                                            ? groupedDataCumulative
                                            : groupedData
                                        )
                                            .filter(
                                                (g) =>
                                                    !(
                                                        g.groupId === null &&
                                                        (!g.accounts || g.accounts.length === 0)
                                                    )
                                            )
                                            .map((group) => {
                                                const key =
                                                    group.groupId !== null ? `g_${group.groupId}` : 'ungrouped';
                                                const isOpen = !!expandedGroups[key];
                                                return (
                                                    <React.Fragment key={key}>
                                                        <tr
                                                            className="bg-white hover:bg-slate-50/80 cursor-pointer transition-all duration-150 hover:shadow-sm hover:-translate-y-[1px]"
                                                            onClick={() => openGroupBreakdown(group)}
                                                        >
                                                            <td className="px-4 py-3">
                                                                <div className="flex items-center gap-3">
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            setExpandedGroups((prev) => ({
                                                                                ...prev,
                                                                                [key]: !prev[key],
                                                                            }));
                                                                        }}
                                                                        className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100/90 transform transition-transform duration-200"
                                                                    >
                                                                        <svg
                                                                            className={`w-4 h-4 transform transition-transform duration-200 ${isOpen ? 'rotate-90' : 'rotate-0'
                                                                                }`}
                                                                            viewBox="0 0 24 24"
                                                                            fill="none"
                                                                            xmlns="http://www.w3.org/2000/svg"
                                                                        >
                                                                            <path
                                                                                d="M9 6l6 6-6 6"
                                                                                stroke="currentColor"
                                                                                strokeWidth="2"
                                                                                strokeLinecap="round"
                                                                                strokeLinejoin="round"
                                                                            />
                                                                        </svg>
                                                                    </button>
                                                                    <div className="text-sm font-semibold text-gray-800">
                                                                        {group.groupName}
                                                                    </div>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-3 text-center text-gray-700 font-medium">
                                                                {group.accounts.length}
                                                            </td>
                                                            <td className="px-4 py-3 text-right font-semibold text-gray-800">
                                                                {formatNumber(group.asked)}
                                                            </td>
                                                            <td className="px-4 py-3 text-right font-semibold text-gray-800">
                                                                {formatNumber(group.approved)}
                                                            </td>
                                                            <td className="px-4 py-3 text-right font-medium text-gray-700">
                                                                {formatChange(
                                                                    group.approved,
                                                                    group.prevApproved
                                                                )}
                                                            </td>
                                                        </tr>

                                                        {isOpen &&
                                                            group.accounts.map((acc) => (
                                                                <tr
                                                                    key={`${key}_a_${acc.account_id}`}
                                                                    className="hover:bg-blue-50/50 cursor-pointer transition-all duration-150 hover:shadow-sm hover:-translate-y-[1px]"
                                                                    onClick={() => setModalAccount(acc)}
                                                                >
                                                                    <td className="px-8 py-2">
                                                                        {acc.account_name}
                                                                    </td>
                                                                    <td className="px-4 py-2 text-center text-gray-700">
                                                                        —
                                                                    </td>
                                                                    <td className="px-4 py-2 text-right font-medium text-gray-700">
                                                                        {formatNumber(acc.asked)}
                                                                    </td>
                                                                    <td className="px-4 py-2 text-right font-medium text-gray-700">
                                                                        {formatNumber(acc.approved)}
                                                                    </td>
                                                                    <td className="px-4 py-2 text-right text-gray-400">
                                                                        —
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                    </React.Fragment>
                                                );
                                            })}
                                    </tbody>
                                </table>
                            </div>

                            {/* footer totals */}
                            <div className="sticky bottom-0 bg-white/90 backdrop-blur-sm border-t p-3 flex items-center justify-end gap-6 rounded-b-2xl">
                                {tableMode === 'period' ? (
                                    <>
                                        <div className="text-sm text-gray-600">Subtotals:</div>
                                        <div className="text-sm font-semibold">
                                            Asked: {formatNumber(totalAsked)}
                                        </div>
                                        <div className="text-sm font-semibold">
                                            Approved: {formatNumber(totalApproved)}
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="text-sm text-gray-600">YTD totals:</div>
                                        <div className="text-sm font-semibold">
                                            Asked:{' '}
                                            {formatNumber(
                                                (breakdownPayload.months || []).reduce(
                                                    (sum, m, idx) => {
                                                        if (m.asked === null || idx > selectedMonthIdx)
                                                            return sum;
                                                        return sum + Number(m.asked || 0);
                                                    },
                                                    0
                                                )
                                            )}
                                        </div>
                                        <div className="text-sm font-semibold">
                                            Approved:{' '}
                                            {formatNumber(
                                                (breakdownPayload.months || []).reduce(
                                                    (sum, m, idx) => {
                                                        if (m.approved === null || idx > selectedMonthIdx)
                                                            return sum;
                                                        return sum + Number(m.approved || 0);
                                                    },
                                                    0
                                                )
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        </>
                    ) : (
                        // NUTRITION TABLE
                        <>
                            <div className="overflow-auto flex-1 rounded-2xl">
                                <table className="min-w-full divide-y divide-gray-200 text-sm">
                                    <thead className="bg-white sticky top-0 z-10">
                                        <tr>
                                            <th className="px-4 py-3 text-left text-gray-700 font-semibold">
                                                School
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                Open days
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                Row count
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                Requested amount
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                Eaters
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                kcal / month (total)
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                kcal / person (month)
                                            </th>
                                            <th className="px-4 py-3 text-right text-gray-700 font-semibold">
                                                kcal / person (day)
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-100">
                                        {nutritionData.length === 0 ? (
                                            <tr>
                                                <td
                                                    className="px-4 py-3 text-center text-gray-500"
                                                    colSpan={8}
                                                >
                                                    No nutrition data for this period.
                                                </td>
                                            </tr>
                                        ) : (
                                            nutritionData
                                                .slice()
                                                .sort((a, b) => {
                                                    const monthA = Number(
                                                        a.totalKcalPerPersonMonth || 0
                                                    );
                                                    const monthB = Number(
                                                        b.totalKcalPerPersonMonth || 0
                                                    );
                                                    const dayA =
                                                        daysInPeriod > 0
                                                            ? monthA / daysInPeriod
                                                            : 0;
                                                    const dayB =
                                                        daysInPeriod > 0
                                                            ? monthB / daysInPeriod
                                                            : 0;
                                                    return dayB - dayA;
                                                })
                                                .map((row, idx) => {
                                                    const schoolId = row.schoolId ?? row.school_id ?? null;
                                                    const schoolName =
                                                        row.schoolName ?? row.school_name ?? '—';
                                                    const kcalPerPersonMonth = Number(
                                                        row.totalKcalPerPersonMonth || 0
                                                    );
                                                    const kcalPerPersonDay =
                                                        daysInPeriod > 0
                                                            ? kcalPerPersonMonth / daysInPeriod
                                                            : 0;

                                                    return (
                                                        <tr
                                                            key={
                                                                schoolId != null
                                                                    ? `nut-${schoolId}`
                                                                    : `nut-${idx}`
                                                            }
                                                            className="hover:bg-amber-50/40 transition-all duration-150"
                                                        >
                                                            <td className="px-4 py-2 text-gray-800 font-medium">
                                                                {schoolName}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-gray-700">
                                                                {daysInPeriod > 0
                                                                    ? daysInPeriod.toLocaleString('en-US', {
                                                                        maximumFractionDigits: 0,
                                                                    })
                                                                    : '—'}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-gray-700">
                                                                {Number(
                                                                    row.rowCount || 0
                                                                ).toLocaleString('en-US', {
                                                                    maximumFractionDigits: 0,
                                                                })}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-gray-700">
                                                                {Number(
                                                                    row.totalRequestedAmount || 0
                                                                ).toLocaleString('en-US', {
                                                                    maximumFractionDigits: 0,
                                                                })}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-gray-700">
                                                                {Number(
                                                                    row.eatingNumber || 0
                                                                ).toLocaleString('en-US', {
                                                                    maximumFractionDigits: 0,
                                                                })}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-gray-700 tabular-nums">
                                                                {Number(row.totalKcalMonth || 0) > 0
                                                                    ? Number(
                                                                        row.totalKcalMonth || 0
                                                                    ).toLocaleString('en-US', {
                                                                        maximumFractionDigits: 0,
                                                                    })
                                                                    : '—'}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-gray-900 font-semibold tabular-nums">
                                                                {kcalPerPersonMonth > 0
                                                                    ? kcalPerPersonMonth.toLocaleString(
                                                                        'en-US',
                                                                        {
                                                                            maximumFractionDigits: 0,
                                                                        }
                                                                    )
                                                                    : '—'}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-amber-900 font-semibold tabular-nums">
                                                                {kcalPerPersonMonth > 0 &&
                                                                    daysInPeriod > 0
                                                                    ? kcalPerPersonDay.toLocaleString(
                                                                        'en-US',
                                                                        {
                                                                            maximumFractionDigits: 0,
                                                                        }
                                                                    )
                                                                    : '—'}
                                                            </td>
                                                        </tr>
                                                    );
                                                })
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            {/* footer for nutrition */}
                            <div className="sticky bottom-0 bg-white/90 backdrop-blur-sm border-t p-3 flex items-center justify-between gap-6 rounded-b-2xl">
                                <div className="text-sm text-gray-600">
                                    Nutrition totals:
                                    {daysInPeriod > 0 && (
                                        <span className="ml-3 text-xs text-gray-500">
                                            Open days (no Fridays):{' '}
                                            {daysInPeriod.toLocaleString('en-US', {
                                                maximumFractionDigits: 0,
                                            })}
                                        </span>
                                    )}
                                </div>
                                <div className="flex gap-6 text-sm">
                                    <div>
                                        kcal (total):{' '}
                                        <span className="font-semibold">
                                            {overallTotalKcalMonth.toLocaleString('en-US', {
                                                maximumFractionDigits: 0,
                                            })}
                                        </span>
                                    </div>
                                    <div>
                                        Eaters:{' '}
                                        <span className="font-semibold">
                                            {overallTotalEaters.toLocaleString('en-US', {
                                                maximumFractionDigits: 0,
                                            })}
                                        </span>
                                    </div>
                                    <div>
                                        kcal / person (month):{' '}
                                        <span className="font-semibold">
                                            {overallKcalPerPersonMonth != null
                                                ? Number(
                                                    overallKcalPerPersonMonth
                                                ).toLocaleString('en-US', {
                                                    maximumFractionDigits: 0,
                                                })
                                                : '—'}
                                        </span>
                                    </div>
                                    <div>
                                        kcal / person (day):{' '}
                                        <span className="font-semibold">
                                            {overallKcalPerPersonDay != null
                                                ? Number(
                                                    overallKcalPerPersonDay
                                                ).toLocaleString('en-US', {
                                                    maximumFractionDigits: 0,
                                                })
                                                : '—'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* RIGHT SIDE */}
                <div className="w-2/5 flex flex-col gap-4 h-full">
                    {/* CHART CARD */}
                    <div
                        className="bg-white/85 backdrop-blur-sm rounded-2xl shadow-[0_16px_35px_rgba(15,23,42,0.1)] border border-slate-100/80 p-4 flex flex-col hover:shadow-[0_24px_50px_rgba(15,23,42,0.12)] transition-shadow duration-200"
                        style={{ flexBasis: '60%' }}
                    >
                        {/* when nutrition tab -> custom header */}
                        {tableMode === 'nutrition' ? (
                            <div className="flex items-center justify-between border-b border-gray-200/60 mb-2">
                                <h3 className="text-sm font-semibold text-gray-700">
                                    Top schools by kcal / person (day)
                                </h3>
                                <span className="text-[11px] text-gray-400">
                                    {selectedPeriod}
                                </span>
                            </div>
                        ) : (
                            <div className="flex items-center justify-between border-b border-gray-200/60 mb-2">
                                <div className="flex">
                                    <button
                                        onClick={() => setActiveTab('pie')}
                                        className={`px-4 py-2 -mb-px font-medium ${activeTab === 'pie'
                                                ? 'border-b-2 border-blue-600 text-blue-600'
                                                : 'text-gray-500'
                                            }`}
                                    >
                                        Pie
                                    </button>
                                    <button
                                        onClick={() => setActiveTab('graph')}
                                        className={`px-4 py-2 -mb-px font-medium ${activeTab === 'graph'
                                                ? 'border-b-2 border-blue-600 text-blue-600'
                                                : 'text-gray-500'
                                            }`}
                                    >
                                        Graph
                                    </button>
                                </div>

                                {activeTab === 'graph' && (
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={chartScope}
                                            onChange={(e) => setChartScope(e.target.value)}
                                            className="rounded-full border px-3 py-1 text-sm bg-white/80 border-gray-200"
                                        >
                                            <option value="overall">Overall</option>
                                            <option value="account">Account</option>
                                            <option value="school">School</option>
                                        </select>

                                        {chartScope === 'account' && (
                                            <select
                                                value={selectedAccountId ?? ''}
                                                onChange={(e) =>
                                                    setSelectedAccountId(e.target.value)
                                                }
                                                className="rounded-full border px-3 py-1 text-sm bg-white/80 border-gray-200"
                                            >
                                                {accountOptions.length === 0 && (
                                                    <option value="">No accounts</option>
                                                )}
                                                {accountOptions.map((opt) => (
                                                    <option
                                                        key={String(opt.id)}
                                                        value={String(opt.id)}
                                                    >
                                                        {opt.label}
                                                    </option>
                                                ))}
                                            </select>
                                        )}

                                        {chartScope === 'school' && (
                                            <select
                                                value={selectedSchoolId ?? ''}
                                                onChange={(e) =>
                                                    setSelectedSchoolId(e.target.value)
                                                }
                                                className="rounded-full border px-3 py-1 text-sm bg-white/80 border-gray-200"
                                            >
                                                {schoolOptions.length === 0 && (
                                                    <option value="">No schools</option>
                                                )}
                                                {schoolOptions.map((opt) => (
                                                    <option
                                                        key={String(opt.id)}
                                                        value={String(opt.id)}
                                                    >
                                                        {opt.label}
                                                    </option>
                                                ))}
                                            </select>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        <div
                            className="flex-1 flex items-center justify-center mt-2"
                            style={{ minHeight: 220 }}
                        >
                            {tableMode === 'nutrition' ? (
                                nutritionData.length === 0 ? (
                                    <div className="text-sm text-gray-400">
                                        No nutrition entries to show
                                    </div>
                                ) : (
                                    <div className="w-full h-full overflow-auto">
                                        <ul className="space-y-2">
                                            {nutritionData
                                                .slice()
                                                .map((row) => {
                                                    const monthVal = Number(
                                                        row.totalKcalPerPersonMonth || 0
                                                    );
                                                    const dayVal =
                                                        daysInPeriod > 0
                                                            ? monthVal / daysInPeriod
                                                            : 0;
                                                    return { row, dayVal };
                                                })
                                                .sort((a, b) => b.dayVal - a.dayVal)
                                                .slice(0, 6)
                                                .map(({ row, dayVal }, idx) => {
                                                    const schoolId =
                                                        row.schoolId ?? row.school_id ?? null;
                                                    const schoolName =
                                                        row.schoolName ??
                                                        row.school_name ??
                                                        '—';

                                                    const barMax = 3000;

                                                    return (
                                                        <li
                                                            key={
                                                                schoolId != null
                                                                    ? `nut-top-${schoolId}`
                                                                    : `nut-top-${idx}`
                                                            }
                                                            className="flex items-center gap-3 bg-amber-50/40 rounded-xl px-2 py-2"
                                                        >
                                                            <div className="w-6 text-xs text-gray-500">
                                                                {idx + 1}
                                                            </div>
                                                            <div className="flex-1">
                                                                <div className="flex items-center justify-between gap-2">
                                                                    <div className="text-sm font-medium text-gray-800">
                                                                        {schoolName}
                                                                    </div>
                                                                    <div className="text-xs text-gray-500">
                                                                        {row.eatingNumber
                                                                            ? `${row.eatingNumber} eater(s)`
                                                                            : ''}
                                                                    </div>
                                                                </div>
                                                                <div className="h-2 bg-amber-100 rounded-full mt-2 overflow-hidden">
                                                                    <div
                                                                        style={{
                                                                            width: `${dayVal > 0
                                                                                    ? Math.min(
                                                                                        100,
                                                                                        (dayVal /
                                                                                            barMax) *
                                                                                        100
                                                                                    )
                                                                                    : 4
                                                                                }%`,
                                                                        }}
                                                                        className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500"
                                                                    />
                                                                </div>
                                                            </div>
                                                            <div className="w-24 text-right text-xs font-semibold text-amber-900 tabular-nums">
                                                                {dayVal > 0
                                                                    ? dayVal.toLocaleString('en-US', {
                                                                        maximumFractionDigits: 0,
                                                                    })
                                                                    : '—'}
                                                            </div>
                                                        </li>
                                                    );
                                                })}
                                        </ul>
                                    </div>
                                )
                            ) : activeTab === 'pie' ? (
                                pieData.length === 0 ? (
                                    <div className="text-sm text-gray-500">No data</div>
                                ) : (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <PieChart>
                                            <Pie
                                                dataKey="value"
                                                data={pieData}
                                                nameKey="name"
                                                innerRadius="40%"
                                                outerRadius="80%"
                                                labelLine={false}
                                                label={labelRenderer}
                                            >
                                                {pieData.map((entry, index) => (
                                                    <Cell
                                                        key={`cell-${index}`}
                                                        fill={COLORS[index % COLORS.length]}
                                                    />
                                                ))}
                                            </Pie>
                                            <RechartsTooltip
                                                formatter={(value) =>
                                                    Number(value).toLocaleString('en-US', {
                                                        maximumFractionDigits: 0,
                                                    })
                                                }
                                            />
                                            <Legend verticalAlign="bottom" height={36} />
                                        </PieChart>
                                    </ResponsiveContainer>
                                )
                            ) : graphData && graphData.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart
                                        data={graphData}
                                        margin={{ top: 16, right: 12, left: 0, bottom: 8 }}
                                    >
                                        <CartesianGrid strokeDasharray="3 3" />
                                        <XAxis dataKey="name" />
                                        <YAxis
                                            tickFormatter={(v) => {
                                                if (v === null || v === undefined) return '';
                                                if (v >= 1_000_000)
                                                    return `${(v / 1_000_000).toFixed(1)}M`;
                                                if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
                                                return v;
                                            }}
                                        />
                                        <RechartsTooltip formatter={tooltipFormatter} />
                                        <Legend verticalAlign="top" height={24} />
                                        <Line
                                            type="monotone"
                                            dataKey="asked"
                                            name={
                                                tableMode === 'cumulative'
                                                    ? 'Asked (YTD)'
                                                    : 'Asked'
                                            }
                                            stroke="#3B82F6"
                                            strokeWidth={2}
                                            dot={{ r: 3 }}
                                            connectNulls={true}
                                        />
                                        <Line
                                            type="monotone"
                                            dataKey="approved"
                                            name={
                                                tableMode === 'cumulative'
                                                    ? 'Approved (YTD)'
                                                    : 'Approved'
                                            }
                                            stroke="#10B981"
                                            strokeWidth={2}
                                            dot={{ r: 3 }}
                                            connectNulls={true}
                                        />
                                    </LineChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="text-sm text-gray-500">
                                    No data for the selected year
                                </div>
                            )}
                        </div>
                    </div>

                    {/* TOP 5 ACCOUNTS or Nutrition note */}
                    <div
                        className="bg-white/85 backdrop-blur-sm rounded-2xl shadow-[0_16px_35px_rgba(15,23,42,0.1)] border border-slate-100/80 p-4 overflow-auto flex flex-col hover:shadow-[0_24px_50px_rgba(15,23,42,0.12)] transition-shadow duration-200"
                        style={{ flexBasis: '40%' }}
                    >
                        {tableMode === 'nutrition' ? (
                            <>
                                <h3 className="text-lg font-semibold text-gray-800 mb-2">
                                    Nutrition details
                                </h3>
                                <p className="text-sm text-gray-600 mb-2">
                                    This tab shows, per school, how many food lines were in that
                                    month, how much they requested, how many students ate, and how
                                    many kcal the month provides per person and per day. Open days
                                    are calculated as all calendar days except Fridays (no food on
                                    Fridays).
                                </p>
                                <p className="text-xs text-gray-400">
                                    Schools with no recorded eaters are not shown at all.
                                </p>
                            </>
                        ) : (
                            <>
                                <div className="flex items-start justify-between">
                                    <h3 className="text-lg font-semibold text-gray-800">
                                        Top Accounts
                                    </h3>
                                    <div className="text-sm text-gray-500">
                                        {tableMode === 'period'
                                            ? 'Showing top 5 by Asked'
                                            : 'Showing top 5 by Asked (YTD)'}
                                    </div>
                                </div>
                                <ul className="mt-4 space-y-3">
                                    {topAccountsData.rows.slice(0, 5).map((acc, idx) => {
                                        const pct = topAccountsData.totalAsked
                                            ? Math.round(
                                                (acc.asked / topAccountsData.totalAsked) * 100
                                            )
                                            : 0;
                                        return (
                                            <li
                                                key={acc.account_id}
                                                className="flex items-center gap-3 bg-white/0 hover:bg-slate-50/60 rounded-xl px-2 py-2 transition-all duration-150 hover:-translate-y-[1px]"
                                            >
                                                <div className="w-6 text-sm font-semibold text-slate-500">
                                                    {idx + 1}
                                                </div>
                                                <div className="flex-1">
                                                    <div className="flex items-baseline justify-between gap-2">
                                                        <button
                                                            onClick={() => setModalAccount(acc)}
                                                            className="text-sm font-medium text-gray-800 hover:underline text-left"
                                                        >
                                                            {acc.account_name}
                                                        </button>
                                                        <div className="text-sm font-semibold text-gray-700">
                                                            {formatNumber(acc.asked)}
                                                        </div>
                                                    </div>
                                                    <div className="h-2 bg-gray-100 rounded-full mt-2 overflow-hidden">
                                                        <div
                                                            style={{ width: `${Math.max(4, pct)}%` }}
                                                            className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400"
                                                        />
                                                    </div>
                                                </div>
                                                <div className="w-10 text-right text-xs text-gray-500">
                                                    {pct}%
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Account modal */}
            {modalAccount && (
                <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-40 z-50">
                    <div className="bg-white rounded-xl shadow-[0_18px_40px_rgba(15,23,42,0.25)] w-full max-w-lg p-6 relative">
                        <h3 className="text-xl font-bold mb-4 text-gray-8
00">
                            {modalAccount.account_name} - School Breakdown
                        </h3>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200 text-sm">
                                <thead className="bg-blue-50">
                                    <tr>
                                        <th className="px-4 py-2 text-left text-gray-700 font-semibold">
                                            School
                                        </th>
                                        <th className="px-4 py-2 text-right text-gray-700 font-semibold">
                                            Asked
                                        </th>
                                        <th className="px-4 py-2 text-right text-gray-700 font-semibold">
                                            Approved
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-100">
                                    {(modalAccount.schoolBreakdown || [])
                                        .sort((a, b) => b.approved - a.approved)
                                        .map((school) => (
                                            <tr
                                                key={school.school_id ?? school.school_name}
                                                className="hover:bg-blue-50 transition-colors duration-150"
                                            >
                                                <td className="px-4 py-2">
                                                    {school.school_name}
                                                </td>
                                                <td className="px-4 py-2 text-right font-medium text-gray-700">
                                                    {formatNumber(school.asked)}
                                                </td>
                                                <td className="px-4 py-2 text-right font-medium text-gray-700">
                                                    {formatNumber(school.approved)}
                                                </td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        </div>
                        <button
                            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
                            onClick={() => setModalAccount(null)}
                        >
                            ✕
                        </button>
                    </div>
                </div>
            )}

            {/* Group modal */}
            {modalGroup && (
                <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-40 z-50">
                    <div className="bg-white rounded-xl shadow-[0_18px_40px_rgba(15,23,42,0.25)] w-full max-w-lg p-6 relative">
                        <h3 className="text-xl font-bold mb-4 text-gray-800">
                            {modalGroup.groupName} — School Breakdown
                        </h3>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200 text-sm">
                                <thead className="bg-blue-50">
                                    <tr>
                                        <th className="px-4 py-2 text-left text-gray-700 font-semibold">
                                            School
                                        </th>
                                        <th className="px-4 py-2 text-right text-gray-700 font-semibold">
                                            Asked
                                        </th>
                                        <th className="px-4 py-2 text-right text-gray-700 font-semibold">
                                            Approved
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-100">
                                    {(modalGroup.rows || []).map((row) => (
                                        <tr
                                            key={row.school_id ?? row.school_name}
                                            className="hover:bg-blue-50 transition-colors duration-150"
                                        >
                                            <td className="px-4 py-2">
                                                {row.school_name}
                                            </td>
                                            <td className="px-4 py-2 text-right font-medium text-gray-700">
                                                {formatNumber(row.asked)}
                                            </td>
                                            <td className="px-4 py-2 text-right font-medium text-gray-700">
                                                {formatNumber(row.approved)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <button
                            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
                            onClick={() => setModalGroup(null)}
                        >
                            ✕
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export default SummaryBudget;
