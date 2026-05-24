function getSaoPauloDate(dateObj = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dateObj);
}

function getSaoPauloTime(dateObj = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(dateObj);
}

function getSaoPauloDateTimeString(dateObj = new Date()) {
  const datePart = getSaoPauloDate(dateObj);
  const timePart = getSaoPauloTime(dateObj);
  const [year, month, day] = datePart.split('-');
  return `${day}-${month}-${year} ${timePart}`;
}

function formatToBrazilDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return dateStr;
}

module.exports = {
  getSaoPauloDate,
  getSaoPauloTime,
  getSaoPauloDateTimeString,
  formatToBrazilDate
};
