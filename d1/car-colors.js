// Original arcade CAR NUMBER order. Tones remain legible on the light lobby UI.
export const CAR_COLORS=Object.freeze([
 {name:'Red',color:'#d52247',hudColor:'#ff394b'}, {name:'Blue',color:'#0874db',hudColor:'#458bff'},
 {name:'Yellow',color:'#c7a600',hudColor:'#fff43a'}, {name:'Green',color:'#17864a',hudColor:'#40ef68'},
 {name:'Black',color:'#34333c',hudColor:'#34333c'}, {name:'Pink',color:'#d2549f',hudColor:'#ff79cc'},
 {name:'Light blue',color:'#279fbe',hudColor:'#64dfff'}, {name:'Orange',color:'#e07714',hudColor:'#ff9b35'}
]);
export const carColor=cabinet=>CAR_COLORS[cabinet-1]||{name:'Unknown',color:'#77776c'};
