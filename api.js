/**
 * Best Agent API - Casablanca Express
 * Caller ID Status Lookup for Retell AI
 * Created: 2026-01-13
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =============================================================================
// CASPIO CONFIGURATION
// =============================================================================

const CASPIO_CONFIG = {
    accountId: process.env.CASPIO_ACCOUNT_ID,
    clientId: process.env.CASPIO_CLIENT_ID,
    clientSecret: process.env.CASPIO_CLIENT_SECRET,
    tables: {
        rims_data: 'RIMS_DATA',
        destsel: 'destsel'
    }
};

let caspioToken = null;
let tokenExpiry = null;

// =============================================================================
// CASPIO AUTHENTICATION
// =============================================================================

async function getCaspioToken() {
    if (caspioToken && tokenExpiry && Date.now() < tokenExpiry) {
        return caspioToken;
    }

    const tokenUrl = `https://${CASPIO_CONFIG.accountId}.caspio.com/oauth/token`;

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: CASPIO_CONFIG.clientId,
            client_secret: CASPIO_CONFIG.clientSecret
        })
    });

    if (!response.ok) {
        throw new Error(`Caspio auth failed: ${response.status}`);
    }

    const data = await response.json();
    caspioToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // 1 min buffer

    console.log('[Caspio] Token refreshed');
    return caspioToken;
}

async function queryCaspioTable(tableName, whereClause = null, pageSize = 100) {
    const token = await getCaspioToken();
    let url = `https://${CASPIO_CONFIG.accountId}.caspio.com/rest/v2/tables/${tableName}/records?q.pageSize=${pageSize}`;

    if (whereClause) {
        url += `&q.where=${encodeURIComponent(whereClause)}`;
    }

    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        throw new Error(`Caspio query failed: ${response.status}`);
    }

    const data = await response.json();
    return data.Result || [];
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function isBusinessHours() {
    const now = new Date();
    const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const day = pst.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const hour = pst.getHours();
    return day >= 1 && day <= 5 && hour >= 9 && hour < 17;
}

function daysUntilDate(dateString) {
    if (!dateString) return null;
    const target = new Date(dateString);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    target.setHours(0, 0, 0, 0);
    return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

function cleanPhone(phone) {
    if (!phone) return '';
    // Remove all non-digits
    let cleaned = phone.replace(/\D/g, '');
    // Remove leading 1 (country code) if 11 digits
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
        cleaned = cleaned.substring(1);
    }
    console.log(`[cleanPhone] Input: "${phone}" -> Output: "${cleaned}"`);
    return cleaned;
}

// =============================================================================
// DESTSEL LOOKUP
// =============================================================================

async function getPackageFromDestsel(pkgCode2) {
    if (!pkgCode2) return null;

    const code = pkgCode2.toUpperCase();
    console.log(`[Destsel] Looking up: ${code}`);

    try {
        const results = await queryCaspioTable(
            CASPIO_CONFIG.tables.destsel,
            `pkgcode2='${code}'`
        );

        if (results && results.length > 0) {
            const pkg = results[0];
            const refDeposit = pkg.ref_dep || 0;
            const confDeposit = pkg.deposit || 0;

            return {
                found: true,
                pkgcode2: code,
                ref_dep: refDeposit,
                deposit: confDeposit,
                total_expected: refDeposit + confDeposit,
                destination: pkg.destination || pkg.dest || null,
                nights: pkg.ngts || pkg.nights || null,
                vacation_type: pkg.vacation_type || null,
                vaca_desc: pkg.vaca_desc || null
            };
        }

        return null;
    } catch (error) {
        console.error(`[Destsel] Error: ${error.message}`);
        return null;
    }
}

// =============================================================================
// STATUS DETERMINATION
// =============================================================================

// Online scheduling packages - customers schedule and pay at activatemytrip.com
const ONLINE_SCHEDULING_PACKAGES = ['ECRA', 'ECRB', 'ECRD', 'EKCA'];

// Phone scheduling packages - customers call to schedule and pay deposit over the phone
// Includes: EM, ES, and packages starting with EX or EZ
function isPhoneSchedulingPackage(pkgCode) {
    if (!pkgCode) return false;
    const code = pkgCode.toUpperCase();
    return code === 'EM' || code === 'ES' || code.startsWith('EX') || code.startsWith('EZ');
}

function determineStatus(customer, packageInfo) {
    const {
        val_dep, conf_deposit, asgn_trv_dt, tm, conf_valid_code,
        cash_back_amt, Fnl_Doc_MO_Date, date_print_enc, decReady,
        date_htl_book, date_agncy_book, pkg_code2
    } = customer;

    // Check if this is an online scheduling package
    const isOnlineScheduling = pkg_code2 && ONLINE_SCHEDULING_PACKAGES.includes(pkg_code2.toUpperCase());

    // Check if this is a phone scheduling package (call to schedule and pay)
    const isPhoneScheduling = isPhoneSchedulingPackage(pkg_code2);

    // Calculate deposits
    const expectedRefDep = packageInfo ? packageInfo.ref_dep : 0;
    const expectedConfDep = packageInfo ? packageInfo.deposit : 0;
    const expectedTotal = packageInfo ? packageInfo.total_expected : null;
    const paidValDep = val_dep || 0;
    const paidConfDep = conf_deposit || 0;
    const totalPaid = paidValDep + paidConfDep;

    // Determine if deposits are complete
    // Special case: If destsel only requires ONE deposit (either ref_dep OR deposit, not both)
    // and customer has paid that amount in EITHER field, consider it paid
    let depositsComplete = false;
    if (expectedTotal !== null) {
        if (totalPaid >= expectedTotal) {
            // Standard case: total paid covers total expected
            depositsComplete = true;
        } else if (expectedRefDep > 0 && expectedConfDep === 0) {
            // Only ref_dep required - check if either paid field matches
            depositsComplete = (paidValDep >= expectedRefDep || paidConfDep >= expectedRefDep);
        } else if (expectedConfDep > 0 && expectedRefDep === 0) {
            // Only deposit required - check if either paid field matches
            depositsComplete = (paidValDep >= expectedConfDep || paidConfDep >= expectedConfDep);
        }
    } else {
        // No package info - assume paid if any deposit exists
        depositsComplete = (paidValDep > 0 || paidConfDep > 0);
    }

    const remaining = expectedTotal !== null ? Math.max(0, expectedTotal - totalPaid) : null;

    const daysUntilTravel = asgn_trv_dt ? daysUntilDate(asgn_trv_dt) : null;

    let status, statusLabel, agentMessage;

    // 1. REFUND PENDING
    if (cash_back_amt && cash_back_amt > 0 && !Fnl_Doc_MO_Date) {
        status = 'Refund Pending';
        statusLabel = 'Refund Pending';
        agentMessage = 'I see there is a pending matter on your account.';
    }
    // 2. TRIP COMPLETE
    else if (Fnl_Doc_MO_Date || (daysUntilTravel !== null && daysUntilTravel < -7)) {
        status = 'Trip Complete';
        statusLabel = 'Trip Complete';
        agentMessage = 'I can see you have already traveled with us.';
    }
    // 3. TRAVEL PENDING
    else if (date_htl_book && date_agncy_book && daysUntilTravel !== null && daysUntilTravel <= 14) {
        status = 'Travel Pending';
        statusLabel = 'Travel Pending';
        agentMessage = 'Your trip is all booked and your itinerary should have been sent.';
    }
    // 4. BOOKING PENDING
    else if (date_print_enc && daysUntilTravel !== null && daysUntilTravel <= 45) {
        status = 'Booking Pending';
        statusLabel = 'Booking Pending';
        agentMessage = 'Your booking is being finalized. Expect a call from our booking agent 7-14 days before your trip.';
    }
    // 5. TRAVEL REP ASSIGNED
    else if (tm && tm.trim() !== '' && daysUntilTravel !== null && daysUntilTravel <= 75) {
        status = 'Travel Rep Assigned';
        statusLabel = 'Travel Rep Assigned';
        agentMessage = 'Your travel rep has been assigned. Be sure to answer calls from the 805 area code.';
    }
    // 6. WAITING FOR TRAVEL REP
    else if (depositsComplete && asgn_trv_dt && (!tm || tm.trim() === '') && daysUntilTravel !== null && daysUntilTravel <= 75) {
        status = 'Waiting For Travel Rep';
        statusLabel = 'Waiting for Travel Rep';
        agentMessage = 'Your travel dates are set and you are waiting for a travel rep to be assigned.';
    }
    // 7. READY TO SCHEDULE
    else if (depositsComplete && !asgn_trv_dt) {
        status = 'Ready to Schedule';
        statusLabel = 'Ready to Schedule';
        if (isOnlineScheduling) {
            agentMessage = 'Great news! Your deposit is all paid up and you are ready to select your travel dates. You can login to your activatemytrip.com account to select your dates.';
        } else if (isPhoneScheduling) {
            agentMessage = 'Great news! Your deposit is all paid up and you are ready to select your travel dates. Would you like me to transfer you to scheduling?';
        } else {
            agentMessage = 'Great news! Your deposit is all paid up and you are ready to select your travel dates.';
        }
    }
    // 8. DATES SCHEDULED (outside TR window)
    else if (depositsComplete && asgn_trv_dt && (!tm || tm.trim() === '') && conf_valid_code === 'CONFIRM' && daysUntilTravel > 75) {
        status = 'Dates Scheduled';
        statusLabel = 'Dates Scheduled';
        agentMessage = `Your travel dates are all set for ${asgn_trv_dt}. A travel rep will be assigned 45-75 days before your trip.`;
    }
    // 9. SCHEDULED NOT CONFIRMED
    else if (asgn_trv_dt && conf_valid_code !== 'CONFIRM' && decReady !== true) {
        if (daysUntilTravel <= 75) {
            status = 'Scheduled Not Confirmed - Must Reschedule';
            statusLabel = 'Needs Rescheduling';
            agentMessage = 'Your scheduled dates may no longer be available. Would you like me to transfer you to reschedule?';
        } else {
            status = 'Scheduled Not Confirmed - Can Confirm';
            statusLabel = 'Needs Confirmation';
            agentMessage = 'Your dates are scheduled but not yet confirmed. Would you like me to transfer you to confirm?';
        }
    }
    // 10. DEPOSIT NEEDED
    else {
        status = 'Deposit Needed';
        statusLabel = 'Deposit Needed';
        if (isOnlineScheduling) {
            agentMessage = 'I see you have activated your vacation package. You can login to your activatemytrip.com account to select your travel dates and pay your deposit with a credit card.';
        } else if (isPhoneScheduling) {
            agentMessage = 'I see you have activated your vacation package. Would you like me to transfer you to scheduling so you can select your dates and pay the deposit over the phone?';
        } else {
            agentMessage = 'I see you have activated your vacation package. It looks like we are just waiting on your deposit.';
        }
    }

    return {
        status,
        statusLabel,
        agentMessage,
        deposits: {
            status: depositsComplete ? 'complete' : 'pending',
            val_dep_paid: paidValDep,
            conf_deposit_paid: paidConfDep,
            total_paid: totalPaid,
            refundable_deposit_required: packageInfo?.ref_dep || null,
            tax_deposit_required: packageInfo?.deposit || null,
            expected_deposit: expectedTotal,
            remaining: remaining,
            complete: depositsComplete
        },
        daysUntilTravel,
        isOnlineScheduling,
        isPhoneScheduling
    };
}

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'best-agent-api',
        version: '1.0.0'
    });
});

/**
 * GET /api/customer/status
 * Main caller ID status lookup endpoint
 * Uses caller's phone number to look up customer and return full status
 */
app.get('/api/customer/status', async (req, res) => {
    const { phone } = req.query;
    console.log(`[Status] Raw request - phone param: "${phone}", full query:`, req.query);

    if (!phone) {
        return res.json({
            found: false,
            status: 'unknown',
            agent_message: 'No phone number provided'
        });
    }

    const phoneClean = cleanPhone(phone);
    console.log(`[Status] Looking up phone: ${phoneClean} (raw: ${phone})`);

    try {
        // Look up customer by phone
        const customers = await queryCaspioTable(
            CASPIO_CONFIG.tables.rims_data,
            `phn1='${phoneClean}' OR phn2='${phoneClean}'`
        );

        if (!customers || customers.length === 0) {
            console.log(`[Status] Customer not found: ${phoneClean}`);
            return res.json({
                found: false,
                status: 'unknown',
                status_label: 'Unknown Caller',
                agent_message: 'Customer not found in our system',
                is_business_hours: isBusinessHours()
            });
        }

        // Sort by val_entered_on (most recent first)
        customers.sort((a, b) => {
            const dateA = a.val_entered_on ? new Date(a.val_entered_on) : new Date(0);
            const dateB = b.val_entered_on ? new Date(b.val_entered_on) : new Date(0);
            return dateB - dateA;
        });

        // Multiple records - ask customer to verify which package
        if (customers.length > 1) {
            console.log(`[Status] Found ${customers.length} records for ${phoneClean}`);

            const allRecords = customers.map((c, index) => ({
                index,
                vac_id: c.vac_id,
                pkg_code2: c.pkg_code2,
                destination: c.dest,
                full_name: `${c.p1F || ''} ${c.p1L || ''}`.trim() || 'Valued Customer',
                val_entered_on: c.val_entered_on
            }));

            const mostRecent = customers[0];
            const fullName = `${mostRecent.p1F || ''} ${mostRecent.p1L || ''}`.trim() || 'Valued Customer';

            return res.json({
                found: true,
                multiple_records: true,
                record_count: customers.length,
                status: 'verification_needed',
                status_label: 'Multiple Packages',
                agent_message: `Are you calling about your package to ${mostRecent.dest || 'your vacation'}?`,
                customer: {
                    full_name: fullName,
                    first_name: mostRecent.p1F || '',
                    last_name: mostRecent.p1L || '',
                    phone: mostRecent.phn1 ? '+1' + mostRecent.phn1 : phone
                },
                all_records: allRecords,
                most_recent: {
                    vac_id: mostRecent.vac_id,
                    pkg_code2: mostRecent.pkg_code2,
                    destination: mostRecent.dest
                },
                is_business_hours: isBusinessHours()
            });
        }

        // Single record - get full status
        const customer = customers[0];
        const fullName = `${customer.p1F || ''} ${customer.p1L || ''}`.trim() || 'Valued Customer';

        // Look up package info from destsel
        const packageInfo = await getPackageFromDestsel(customer.pkg_code2);

        // Determine status
        const statusInfo = determineStatus(customer, packageInfo);

        console.log(`[Status] Found: ${fullName}, Status: ${statusInfo.status}`);

        return res.json({
            found: true,
            status: statusInfo.status,
            status_label: statusInfo.statusLabel,
            agent_message: statusInfo.agentMessage,
            customer: {
                full_name: fullName,
                first_name: customer.p1F || '',
                last_name: customer.p1L || '',
                email: customer.email || '',
                phone: customer.phn1 ? '+1' + customer.phn1 : phone,
                vac_id: customer.vac_id,
                pkg_code2: customer.pkg_code2,
                destination: customer.dest,
                travel_date: customer.asgn_trv_dt || null,
                days_until_travel: statusInfo.daysUntilTravel,
                travel_rep_name: customer.tm || null
            },
            deposits: statusInfo.deposits,
            package: packageInfo ? {
                description: packageInfo.vaca_desc,
                destination: packageInfo.destination,
                nights: packageInfo.nights,
                vacation_type: packageInfo.vacation_type
            } : null,
            is_online_scheduling: statusInfo.isOnlineScheduling,
            is_phone_scheduling: statusInfo.isPhoneScheduling,
            is_business_hours: isBusinessHours()
        });

    } catch (error) {
        console.error(`[Status] Error: ${error.message}`);
        return res.json({
            found: false,
            status: 'error',
            status_label: 'Error',
            agent_message: 'I had trouble looking up your account. How can I help you today?',
            is_business_hours: isBusinessHours()
        });
    }
});

/**
 * POST /api/customer/status-by-id
 * Get status for a specific customer by vac_id and pkg_code2
 * Used after verifying which package customer is calling about
 */
app.post('/api/customer/status-by-id', async (req, res) => {
    const { vac_id, pkg_code2 } = req.body;

    if (!vac_id) {
        return res.json({
            found: false,
            error: 'vac_id is required'
        });
    }

    console.log(`[Status By ID] Looking up vac_id: ${vac_id}`);

    try {
        const results = await queryCaspioTable(
            CASPIO_CONFIG.tables.rims_data,
            `vac_id=${vac_id}`
        );

        if (!results || results.length === 0) {
            return res.json({
                found: false,
                error: 'Customer not found'
            });
        }

        const customer = results[0];
        const fullName = `${customer.p1F || ''} ${customer.p1L || ''}`.trim() || 'Valued Customer';

        const packageInfo = await getPackageFromDestsel(customer.pkg_code2 || pkg_code2);
        const statusInfo = determineStatus(customer, packageInfo);

        console.log(`[Status By ID] Found: ${fullName}, Status: ${statusInfo.status}`);

        return res.json({
            found: true,
            status: statusInfo.status,
            status_label: statusInfo.statusLabel,
            agent_message: statusInfo.agentMessage,
            customer: {
                full_name: fullName,
                first_name: customer.p1F || '',
                last_name: customer.p1L || '',
                email: customer.email || '',
                phone: customer.phn1 ? '+1' + customer.phn1 : '',
                vac_id: customer.vac_id,
                pkg_code2: customer.pkg_code2,
                destination: customer.dest,
                travel_date: customer.asgn_trv_dt || null,
                days_until_travel: statusInfo.daysUntilTravel,
                travel_rep_name: customer.tm || null
            },
            deposits: statusInfo.deposits,
            package: packageInfo ? {
                description: packageInfo.vaca_desc,
                destination: packageInfo.destination,
                nights: packageInfo.nights,
                vacation_type: packageInfo.vacation_type
            } : null,
            is_online_scheduling: statusInfo.isOnlineScheduling,
            is_phone_scheduling: statusInfo.isPhoneScheduling,
            is_business_hours: isBusinessHours()
        });

    } catch (error) {
        console.error(`[Status By ID] Error: ${error.message}`);
        return res.json({
            found: false,
            error: error.message
        });
    }
});

/**
 * POST /api/rims/phone-lookup
 * Look up customer by phone number (compatible with existing flows)
 */
app.post('/api/rims/phone-lookup', async (req, res) => {
    const { phone_number } = req.body;

    if (!phone_number) {
        return res.json({ found: false, message: 'Phone number required' });
    }

    const phoneClean = cleanPhone(phone_number);
    console.log(`[Phone Lookup] Looking up: ${phoneClean}`);

    try {
        const results = await queryCaspioTable(
            CASPIO_CONFIG.tables.rims_data,
            `phn1='${phoneClean}' OR phn2='${phoneClean}'`
        );

        if (!results || results.length === 0) {
            return res.json({ found: false, message: 'Customer not found' });
        }

        // Sort by val_entered_on
        results.sort((a, b) => {
            const dateA = a.val_entered_on ? new Date(a.val_entered_on) : new Date(0);
            const dateB = b.val_entered_on ? new Date(b.val_entered_on) : new Date(0);
            return dateB - dateA;
        });

        const customer = results[0];

        return res.json({
            found: true,
            customer: {
                vac_id: customer.vac_id,
                name: `${customer.p1F || ''} ${customer.p1L || ''}`.trim(),
                pkg_code2: customer.pkg_code2,
                destination: customer.dest,
                phone: customer.phn1
            },
            all_records: results.map(c => ({
                vac_id: c.vac_id,
                pkg_code2: c.pkg_code2,
                destination: c.dest,
                name: `${c.p1F || ''} ${c.p1L || ''}`.trim()
            }))
        });

    } catch (error) {
        console.error(`[Phone Lookup] Error: ${error.message}`);
        return res.json({ found: false, error: error.message });
    }
});

/**
 * POST /api/rims/customer-status
 * Get customer status by vac_id and pkg_code2
 */
app.post('/api/rims/customer-status', async (req, res) => {
    const { vac_id, pkg_code2, phone_number } = req.body;

    if (!vac_id && !phone_number) {
        return res.json({ found: false, error: 'vac_id or phone_number required' });
    }

    console.log(`[Customer Status] Looking up vac_id: ${vac_id}, pkg_code2: ${pkg_code2}`);

    try {
        let whereClause;
        if (vac_id) {
            whereClause = `vac_id=${vac_id}`;
        } else {
            const phoneClean = cleanPhone(phone_number);
            whereClause = `phn1='${phoneClean}' OR phn2='${phoneClean}'`;
        }

        const results = await queryCaspioTable(CASPIO_CONFIG.tables.rims_data, whereClause);

        if (!results || results.length === 0) {
            return res.json({ found: false, message: 'Customer not found' });
        }

        const customer = results[0];
        const fullName = `${customer.p1F || ''} ${customer.p1L || ''}`.trim() || 'Valued Customer';

        const packageInfo = await getPackageFromDestsel(customer.pkg_code2 || pkg_code2);
        const statusInfo = determineStatus(customer, packageInfo);

        console.log(`[Customer Status] Found: ${fullName}, Status: ${statusInfo.status}`);

        return res.json({
            found: true,
            status: statusInfo.status,
            status_label: statusInfo.statusLabel,
            agent_message: statusInfo.agentMessage,
            customer: {
                full_name: fullName,
                first_name: customer.p1F || '',
                last_name: customer.p1L || '',
                email: customer.email || '',
                phone: customer.phn1 ? '+1' + customer.phn1 : '',
                vac_id: customer.vac_id,
                pkg_code2: customer.pkg_code2,
                destination: customer.dest,
                travel_date: customer.asgn_trv_dt || null,
                days_until_travel: statusInfo.daysUntilTravel,
                travel_rep_name: customer.tm || null
            },
            deposits: statusInfo.deposits,
            details: {
                deposits: statusInfo.deposits
            },
            package: packageInfo ? {
                description: packageInfo.vaca_desc,
                destination: packageInfo.destination,
                nights: packageInfo.nights
            } : null,
            is_online_scheduling: statusInfo.isOnlineScheduling,
            is_phone_scheduling: statusInfo.isPhoneScheduling,
            is_business_hours: isBusinessHours()
        });

    } catch (error) {
        console.error(`[Customer Status] Error: ${error.message}`);
        return res.json({ found: false, error: error.message });
    }
});

/**
 * POST /api/memos/create
 * Create a memo in the customer's account (stub - logs for now)
 */
app.post('/api/memos/create', async (req, res) => {
    const { vac_id, memo_type, details } = req.body;

    console.log(`[Memo] Creating memo for vac_id: ${vac_id}, type: ${memo_type}, details: ${details}`);

    // For now, just acknowledge - full implementation would write to Caspio
    return res.json({
        success: true,
        message: 'Memo logged',
        vac_id,
        memo_type,
        details,
        timestamp: new Date().toISOString()
    });
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use((err, req, res, next) => {
    console.error('[Error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
    console.log(`Best Agent API running on port ${PORT}`);
    console.log(`Created: 2026-01-13`);
});

