"use strict";

const fs = require("fs");
const util = require('util');
const mathjs = require("mathjs");
const puppeteer = require("puppeteer");
const select = require ('puppeteer-select');
const tesseract = require("node-tesseract-ocr")
const request = require('request-promise');
const config = {
    lang: "eng+equ",
    oem: 1,
    psm: 7,
}
var knownAnswers = {};
var did = 0;
var participants;

async function getParticipantsIds () {
	const browser = await puppeteer.launch({headless: true ,args: ['--no-sandbox', '--disable-setuid-sandbox']});

	const page = await browser.newPage();

	await page.setRequestInterception(true);

	await page.setDefaultNavigationTimeout(60000);

	page.on('request', (request) => {
		if (['image', 'stylesheet', 'font'].indexOf(request.resourceType()) !== -1) {
			request.abort();
		} else {
			request.continue();
		}
	});

	page.on('load', () => console.log("Loaded: " + page.url()));

	await page.goto("https://olimpiada.ic.unicamp.br/fase2/consulta_classif");

	await page.addScriptTag({url: 'https://code.jquery.com/jquery-3.2.1.min.js'});


	await page.evaluate(() => {
		$('#id_compet_level').val(4);
		$('button[type="submit"]').click();
	});

	await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

    await page.goto("https://olimpiada.ic.unicamp.br/fase2/consulta_classif_resp?page=all");

    await page.addScriptTag({url: 'https://code.jquery.com/jquery-3.2.1.min.js'});
    
    participants = await page.evaluate(()=>{
        var participants = [];
        $("table.basic tr").each((index,element)=>{
        if($(element).hasClass("odd") || $(element).hasClass("even")){
            var obj = {};
            obj.registerNum = $($(element).children()[0]).text()
            obj.name = $($(element).children()[1]).text();
            obj.school = $($(element).children()[3]).text();
            obj.city = $($(element).children()[4]).text();
            participants.push(obj);
        }
        });
        return participants;
    });

    var json = JSON.stringify(participants);

    fs.writeFileSync("./participants.json",json);

	browser.close();
}

async function getGrades (level) {
    await loadData();

	const browser = await puppeteer.launch({headless: true ,args: ['--no-sandbox', '--disable-setuid-sandbox']});

    const page = await browser.newPage();
    
    await page.setRequestInterception(true);

	await page.setDefaultNavigationTimeout(60000);

	page.on('request', (request) => {
		if (['image', 'stylesheet', 'font'].indexOf(request.resourceType()) !== -1) {
			request.abort();
		} else {
			request.continue();
		}
	});

    page.on('load', () => console.log("Loaded: " + page.url()));
    
    let index = 0;
    for(var part of participants){
        await getGradeSingleParticipant(level,index,part.registerNum,page);
        index++;
    }
	
	browser.close();
}

async function getGradeSingleParticipant(level,index,id, page){
    var url;
    var originalLevel = level;
    switch(level){
        case 1: level = "grade1"
            url = "https://olimpiada.ic.unicamp.br/fase1/programacao/consulta_res";
            break;
        case 2: level = "grade2"
            url = "https://olimpiada.ic.unicamp.br/fase2/programacao/consulta_res";
            break;
        case 3: level = "grade"
            url = "https://olimpiada.ic.unicamp.br/fase3/resultados/programacao/consulta_res_prog";
            break;
        default:
            console.log("INVALID LEVEL");
            return;
    }
    if(false && participants[index][level] != undefined && participants[index][level]!=null && participants[index][level] != -1){
        did++;
        console.log("Faltam: "+(participants.length - did).toString());
        return;
    }

	await page.goto(url);

	await page.addScriptTag({url: 'https://code.jquery.com/jquery-3.2.1.min.js'});

	var url = await page.evaluate((id) => {
        $("#id_compet_id").val(id);
        return $("img.captcha").attr("src");
    },id);

    var captchaId = url.split('/')[3];

    url = "https://olimpiada.ic.unicamp.br"+url;

    var ans;
    if(knownAnswers[captchaId]!=null && knownAnswers[captchaId]!=undefined){
        ans = knownAnswers[captchaId];
        console.log("DID AGAIN!");
    }else{
        ans = await solveCaptcha(url);
    }

    console.log(ans);

    if(ans!=null){
        await page.evaluate((ans) => {
            $("#id_captcha_1").val(ans);
            $('button[type="submit"]').click();
        },ans);
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        var ex = await page.evaluate(()=>{
            return $("li:contains('Resposta inválida')").length;
        });
        if(ex > 0){
            knownAnswers[captchaId] = null;
            console.log("WRONG CAPTCHA");
            await getGradeSingleParticipant(originalLevel,index,id,page);
            return;
        }else{
            knownAnswers[captchaId] = ans;
            var grade = await page.evaluate(()=>{
                var doc = document.querySelectorAll('div[role="main"] b')[2];

                var text = [
                  doc.nextSibling.textContent.trim(),
                  doc.nextElementSibling.textContent.trim()
                ];
                
                text = text[0].split(":")[1].trim().replace(/(\r\n|\n|\r)/gm, "").split("pontos")[0].trim();
                if(text != "não encontrada"){
                    return parseInt(text);
                }else{
                    return -1;
                }
            });
            participants[index][level] = grade;
            fs.writeFileSync("./participants.json",JSON.stringify(participants));
            fs.writeFileSync("./knwon.json",JSON.stringify(knownAnswers));
            did++;
            console.log("Faltam: "+(participants.length - did).toString());
            return;
        }
    }else{
        knownAnswers[captchaId] = null;
        await getGradeSingleParticipant(originalLevel,index,id,page);
        return;
    }
    
}

var download = function(uri, filename, callback){
    request.head(uri, function(err, res, body){
      request(uri).pipe(fs.createWriteStream(filename)).on('close', callback);
    });
};
const downloadPromise = util.promisify(download);

async function solveCaptcha(url){
    try{
        await downloadPromise(url, 'cap.png');
        var math = await tesseract.recognize("./cap.png", config);
        math = math.split("=")[0];
        math = math.replace("%","").replace(/(\r\n|\n|\r)/gm, "").replace(" ","");
        console.log(math);
        return mathjs.evaluate(math);
    }catch(e){
        return null;
    }
}

async function loadData(){
    try{
        knownAnswers = JSON.parse(fs.readFileSync("./knwon.json"));
    }catch(e){
        knownAnswers = {};
    }

    try{
        participants = JSON.parse(fs.readFileSync("./participants.json"));
    }catch(e){
        await getParticipantsIds();
    }
}

async function sort(){
    await loadData();
    participants.sort((a, b) => {
        if(a.grade > b.grade){
            return -1;
        }else if(a.grade < b.grade){
            return 1;
        }else{
            if(a.grade2 > b.grade2){
                return -1;
            }else if(a.grade2 < b.grade2){
                return 1;
            } else{
                if(a.grade1 > b.grade1){
                    return -1;
                }else if(a.grade1 < b.grade1){
                    return 1;
                }else{
                    if(a.name < b.name){
                        return -1;
                    }else{
                        return 1;
                    }   
                }
            }
        }
    });
    fs.writeFileSync('./participants.json',JSON.stringify(participants));
}


async function printToFile(){
    await loadData();
    var index = 1;
    fs.writeFileSync("./result.txt",'');
    for(var part of participants){
        let str = "#######################################\n";
        str+=index.toString();
        str+=": "+part.registerNum+" - "+part.name+"\nEscola: "+part.school+"\nCidade:"+part.city+"\nFase Nacional:"+part.grade+"\nFase Estadual: "+part.grade2+"\nFase Regional: "+part.grade1+"\n#######################################\n";
        console.log(str);
        fs.appendFileSync('./result.txt',str);
        index++;
    }
}

async function main(){
    //await getGrades(1);
    //await getGrades(2);
    await getGrades(3);
    await sort();
    await printToFile();
}

main();